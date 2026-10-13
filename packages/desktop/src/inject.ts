//! One-click setup: registers Knot as an MCP server in each agent's user-level config.
//! (Ported from the Rust inject.rs.)
//! - Claude Code: top-level `mcpServers` key of ~/.claude.json, entry {"type":"http", url}.
//! - Codex: `[mcp_servers.knot]` table with `url` in ~/.codex/config.toml (TOML —
//!   edited section-wise, never a whole-file JSON parse).
//! - Hermes: `mcp_servers.knot` mapping with `url` in ~/.hermes/config.yaml
//!   (per hermes-agent's official MCP docs — Claude's mcpServers block maps to
//!   mcp_servers there; edited line-wise to keep comments intact).
//! - JoyCode: top-level `mcpServers` key of ~/.joycode/joycode-mcp.json, entry
//!   {url, disabled:false} (mirrors JoyCode's own http-server entries, which carry
//!   no `type` field).
//! - WorkBuddy: top-level `mcpServers` key of ~/.workbuddy/mcp.json, entry
//!   {type:"http", url, disabled:false} (mirrors workbuddy's own http entries —
//!   its mcp.json is Claude-shaped and its streamable-HTTP client reads `type`).
//!   Note: writing the file only *declares* the server — workbuddy won't start it
//!   until the user explicitly trusts it in 连接器管理 → 自定义连接器 (approval is
//!   recorded in ~/.workbuddy/mcp-approvals.json); after trusting, a NEW SESSION
//!   picks it up — no app restart needed.
//! Every write is preceded by an automatic `<file>.knot-backup` copy.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mcpPort } from "./mcp-server";
import { appendTomlSection, hasTomlSection, stripTomlSection } from "./toml-section";
import {
  hasYamlMappingEntry,
  removeYamlMappingEntry,
  upsertYamlMappingEntry,
} from "./yaml-section";

const SERVER_KEY = "knot";
/** Pre-rename server key; cleaned up on uninject so old installs migrate cleanly. */
const LEGACY_SERVER_KEY = "knot-shared-memory";

/** Agents Knot can register itself with. The renderer's connector cards are
 *  generated from this union; keep api.ts's ConnectorAgent in sync. */
export type ConnectorAgent = "claude-code" | "codex" | "hermes" | "joycode" | "workbuddy";

export const CONNECTOR_AGENTS: ConnectorAgent[] = [
  "claude-code",
  "codex",
  "hermes",
  "joycode",
  "workbuddy",
];

/** Per-agent spec: config file location + the mcpServers entry shape it expects. */
function agentSpec(agent: ConnectorAgent): {
  label: string;
  /** Directory holding the config file (created on write for JoyCode). */
  dir: string;
  /** Config file basename. */
  file: string;
  /** JSON agents: the `mcpServers.knot` entry value to write. */
  entry?: Record<string, unknown>;
  /** TOML agents (codex): section body lines written under [mcp_servers.knot]. */
  tomlLines?: string[];
  /** YAML agents (hermes): entry body lines written under rootKey → knot. */
  yamlEntry?: { rootKey: string; lines: string[] };
  /** How a config change takes effect, phrased for the inject result message
   *  (most agents read their config per session; workbuddy also needs trust). */
  effect: string;
} {
  // The agent identity rides in the URL path (/mcp/<agent>): the HTTP MCP endpoint
  // is stateless, so per-connection clientInfo can't be remembered — the path
  // segment reaches the server on every request and drives the "others-first"
  // recall filter (claude-code sees codex/joycode memories, not its own).
  const url = `http://127.0.0.1:${mcpPort()}/mcp/${agent}`;
  switch (agent) {
    case "claude-code":
      return {
        label: "Claude Code",
        dir: os.homedir(),
        file: ".claude.json",
        entry: { type: "http", url },
        effect: "新会话生效",
      };
    case "codex":
      return {
        label: "Codex",
        dir: path.join(os.homedir(), ".codex"),
        file: "config.toml",
        tomlLines: [`url = ${JSON.stringify(url)}`],
        effect: "新会话生效",
      };
    case "hermes":
      return {
        label: "Hermes",
        dir: path.join(os.homedir(), ".hermes"),
        file: "config.yaml",
        yamlEntry: { rootKey: "mcp_servers", lines: [`url: ${JSON.stringify(url)}`] },
        effect: "新会话生效",
      };
    case "joycode":
      return {
        label: "JoyCode",
        dir: path.join(os.homedir(), ".joycode"),
        file: "joycode-mcp.json",
        entry: { url, disabled: false },
        effect: "新会话生效",
      };
    case "workbuddy":
      return {
        label: "WorkBuddy",
        dir: path.join(os.homedir(), ".workbuddy"),
        file: "mcp.json",
        entry: { type: "http", url, disabled: false },
        effect: "在「连接器管理 → 自定义连接器」中信任该服务后新会话生效",
      };
  }
}

function configPath(agent: ConnectorAgent): string {
  const spec = agentSpec(agent);
  return path.join(spec.dir, spec.file);
}

function readConfig(p: string): Record<string, any> {
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    throw new Error(`解析 ${p} 失败（文件不是合法 JSON）: ${e}`);
  }
}

/** Atomic write (temp file + rename): a crash mid-write must never truncate the
 *  config file, and rename avoids the read-modify-write window clobbering a
 *  concurrent update from the agent itself with a torn file. */
function writeConfig(
  agent: ConnectorAgent,
  p: string,
  value: Record<string, any>,
): void {
  atomicWrite(agent, p, JSON.stringify(value, null, 2) + "\n");
}

function atomicWrite(agent: ConnectorAgent, p: string, text: string): void {
  const spec = agentSpec(agent);
  // JoyCode/hermes's config dir may not exist yet on a fresh install.
  fs.mkdirSync(spec.dir, { recursive: true });
  const tmp = `${p}.knot-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

function backup(p: string): void {
  if (fs.existsSync(p)) fs.copyFileSync(p, p + ".knot-backup");
}

// ---------- Public API (dispatch per config format) ----------

export function inject(agent: ConnectorAgent): string {
  const spec = agentSpec(agent);
  const p = configPath(agent);
  backup(p);
  const text = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
  if (spec.tomlLines) {
    // TOML (codex): strip our old section(s), then append the fresh one at EOF.
    const stripped = stripTomlSection(
      stripTomlSection(text, SERVER_KEY),
      LEGACY_SERVER_KEY,
    );
    atomicWrite(agent, p, appendTomlSection(stripped, SERVER_KEY, spec.tomlLines));
  } else if (spec.yamlEntry) {
    // YAML (hermes): upsert the entry under the root mapping (comments kept).
    const { rootKey, lines: entryLines } = spec.yamlEntry;
    atomicWrite(
      agent,
      p,
      upsertYamlMappingEntry(text, rootKey, SERVER_KEY, entryLines),
    );
  } else {
    const config = readConfig(p);
    if (!config.mcpServers || typeof config.mcpServers !== "object") {
      config.mcpServers = {};
    }
    config.mcpServers[SERVER_KEY] = spec.entry!;
    // Pre-rename installs keep a stale stdio entry — replacing it is the point of inject,
    // but drop it explicitly so remove()/isInjected() never see two keys for one app.
    delete config.mcpServers[LEGACY_SERVER_KEY];
    writeConfig(agent, p, config);
  }
  return `Knot 记忆总线已绑定至 ${spec.label}（${p}），${spec.effect}。`;
}

export function remove(agent: ConnectorAgent): string {
  const spec = agentSpec(agent);
  const p = configPath(agent);
  const text = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
  const notBound = `Knot 未绑定过 ${spec.label}，无需解绑。`;
  if (spec.tomlLines) {
    const next = stripTomlSection(
      stripTomlSection(text, SERVER_KEY),
      LEGACY_SERVER_KEY,
    );
    if (next === text) return notBound;
    backup(p);
    atomicWrite(agent, p, next);
  } else if (spec.yamlEntry) {
    const root = spec.yamlEntry.rootKey;
    const hasNew = hasYamlMappingEntry(text, root, SERVER_KEY);
    const hasLegacy = hasYamlMappingEntry(text, root, LEGACY_SERVER_KEY);
    if (!hasNew && !hasLegacy) return notBound;
    backup(p);
    atomicWrite(
      agent,
      p,
      removeYamlMappingEntry(
        removeYamlMappingEntry(text, root, SERVER_KEY),
        root,
        LEGACY_SERVER_KEY,
      ),
    );
  } else {
    const config = readConfig(p);
    if (config.mcpServers && typeof config.mcpServers === "object") {
      const hadNew = SERVER_KEY in config.mcpServers;
      const hadLegacy = LEGACY_SERVER_KEY in config.mcpServers;
      if (!hadNew && !hadLegacy) return notBound;
      backup(p);
      delete config.mcpServers[SERVER_KEY];
      delete config.mcpServers[LEGACY_SERVER_KEY];
      writeConfig(agent, p, config);
    } else {
      return notBound;
    }
  }
  return `已解绑 Knot 记忆总线（${p}），新会话生效。`;
}

export function isInjected(agent: ConnectorAgent): boolean {
  try {
    const p = configPath(agent);
    const text = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
    const spec = agentSpec(agent);
    if (spec.tomlLines) {
      return (
        hasTomlSection(text, SERVER_KEY) || hasTomlSection(text, LEGACY_SERVER_KEY)
      );
    }
    if (spec.yamlEntry) {
      const root = spec.yamlEntry.rootKey;
      return (
        hasYamlMappingEntry(text, root, SERVER_KEY) ||
        hasYamlMappingEntry(text, root, LEGACY_SERVER_KEY)
      );
    }
    const config = readConfig(p);
    return !!(
      config.mcpServers?.[SERVER_KEY] || config.mcpServers?.[LEGACY_SERVER_KEY]
    );
  } catch {
    return false;
  }
}

/** Parse/validate an agent id coming over IPC; throws on anything unknown. */
export function asAgent(value: unknown): ConnectorAgent {
  if (
    value === "claude-code" ||
    value === "codex" ||
    value === "hermes" ||
    value === "joycode" ||
    value === "workbuddy"
  ) {
    return value;
  }
  throw new Error(`未知的连接器 Agent：${value}`);
}
