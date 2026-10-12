//! One-click setup: registers Knot as an MCP server in each agent's user-level config.
//! (Ported from the Rust inject.rs.)
//! - Claude Code: top-level `mcpServers` key of ~/.claude.json, entry {"type":"http", url}.
//! - JoyCode: top-level `mcpServers` key of ~/.joycode/joycode-mcp.json, entry
//!   {url, disabled:false} (mirrors JoyCode's own http-server entries, which carry
//!   no `type` field).
//! Every write is preceded by an automatic `<file>.knot-backup` copy.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mcpPort } from "./mcp-server";

const SERVER_KEY = "knot";
/** Pre-rename server key; cleaned up on uninject so old installs migrate cleanly. */
const LEGACY_SERVER_KEY = "knot-shared-memory";

/** Agents Knot can register itself with. The renderer's connector cards are
 *  generated from this union; keep api.ts's ConnectorAgent in sync. */
export type ConnectorAgent = "claude-code" | "joycode";

export const CONNECTOR_AGENTS: ConnectorAgent[] = ["claude-code", "joycode"];

/** Per-agent spec: config file location + the mcpServers entry shape it expects. */
function agentSpec(agent: ConnectorAgent): {
  label: string;
  /** Directory holding the config file (created on write for JoyCode). */
  dir: string;
  /** Config file basename. */
  file: string;
  /** The `mcpServers.knot` entry value to write. */
  entry: Record<string, unknown>;
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
      };
    case "joycode":
      return {
        label: "JoyCode",
        dir: path.join(os.homedir(), ".joycode"),
        file: "joycode-mcp.json",
        entry: { url, disabled: false },
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
  const spec = agentSpec(agent);
  // JoyCode's config dir may not exist yet on a fresh install.
  fs.mkdirSync(spec.dir, { recursive: true });
  const tmp = `${p}.knot-tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

function backup(p: string): void {
  if (fs.existsSync(p)) fs.copyFileSync(p, p + ".knot-backup");
}

export function inject(agent: ConnectorAgent): string {
  const spec = agentSpec(agent);
  const p = configPath(agent);
  backup(p);
  const config = readConfig(p);
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }
  config.mcpServers[SERVER_KEY] = spec.entry;
  // Pre-rename installs keep a stale stdio entry — replacing it is the point of inject,
  // but drop it explicitly so remove()/isInjected() never see two keys for one app.
  delete config.mcpServers[LEGACY_SERVER_KEY];
  writeConfig(agent, p, config);
  return `Knot 记忆总线已绑定至 ${spec.label}（${p} → mcpServers.${SERVER_KEY}），重启 ${spec.label} 后生效。`;
}

export function remove(agent: ConnectorAgent): string {
  const spec = agentSpec(agent);
  const p = configPath(agent);
  const config = readConfig(p);
  if (config.mcpServers && typeof config.mcpServers === "object") {
    const hadNew = SERVER_KEY in config.mcpServers;
    const hadLegacy = LEGACY_SERVER_KEY in config.mcpServers;
    if (hadNew || hadLegacy) {
      backup(p);
      delete config.mcpServers[SERVER_KEY];
      delete config.mcpServers[LEGACY_SERVER_KEY];
      writeConfig(agent, p, config);
      return `已解绑 Knot 记忆总线，重启 ${spec.label} 后生效。`;
    }
  }
  return `Knot 未绑定过 ${spec.label}，无需解绑。`;
}

export function isInjected(agent: ConnectorAgent): boolean {
  try {
    const config = readConfig(configPath(agent));
    return !!(
      config.mcpServers?.[SERVER_KEY] || config.mcpServers?.[LEGACY_SERVER_KEY]
    );
  } catch {
    return false;
  }
}

/** Parse/validate an agent id coming over IPC; throws on anything unknown. */
export function asAgent(value: unknown): ConnectorAgent {
  if (value === "claude-code" || value === "joycode") return value;
  throw new Error(`未知的连接器 Agent：${value}`);
}
