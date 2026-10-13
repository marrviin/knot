/** Renderer API layer. Display + facts CRUD call the memory service directly
 *  over HTTP via the generated hey-api client (openapi.json → src/client), so
 *  the same code path serves the desktop webview and the future browser build;
 *  desktop-only capabilities (directory picker, MCP injection, watch rules,
 *  settings, import events) stay on window.knot IPC from the preload.
 *
 *  Bootstrap: desktop calls initMemoryEndpoint() once at startup (memory_endpoint
 *  IPC → setMemoryEndpoint); the future web build reads its saved service config
 *  from localStorage into the same entry. */

import type { Fact, Project } from "./types";
import {
  addFact as addFactHttp,
  deleteFact as deleteFactHttp,
  listFacts as listFactsHttp,
  listProjects as listProjectsHttp,
  registerProject as registerProjectHttp,
  removeProject as removeProjectHttp,
  searchMemories as searchMemoriesHttp,
  updateFact as updateFactHttp,
} from "./client";
import { getMemoryEndpoint, setMemoryEndpoint } from "./api-http";
import {
  getSearchHistory as getSearchHistoryLocal,
  pushSearchHistory as pushSearchHistoryLocal,
} from "./search-history";

declare global {
  interface Window {
    knot: {
      invoke: <T = void>(command: string, ...args: unknown[]) => Promise<T>;
      listen: (event: string, cb: (payload: any) => void) => () => void;
      getPathForFile: (file: File) => string;
    };
  }
}

// ---------- HTTP endpoint bootstrap ----------

/** Connect the generated client to the memory service. Desktop: IPC returns the
 *  child process's loopback base + per-launch bearer token. Returns false when
 *  the service is disabled/unconfigured — callers surface the Chinese notice. */
export async function initMemoryEndpoint(): Promise<boolean> {
  const ep = await window.knot.invoke<{ base: string; token: string | null } | null>(
    "memory_endpoint",
  );
  if (!ep) return false;
  setMemoryEndpoint(ep);
  return true;
}

/** Desktop post-mutation mirror sync: the main process reconciles its local
 *  mirror store (MCP keyword search + hybrid search read it) from the service
 *  after the renderer mutated facts over HTTP. No-op cost when nothing changed. */
export const syncMirror = (projectId: string) =>
  window.knot.invoke("sync_mirror", projectId);

/** Throw with the standard notice when the endpoint was never bootstrapped
 *  (service disabled in settings) — display APIs would otherwise fire requests
 *  at an unset baseUrl. */
function requireEndpoint(): void {
  if (!getMemoryEndpoint()) {
    throw new Error("记忆服务未连接（未启用或未配置）");
  }
}

// ---------- Projects ----------

/** Reserved id of the global-memory virtual project (pinned first by the
 *  server's registry seed, not removable); agent-level memories like hermes's land here */
export const GLOBAL_PROJECT = "__global__";

interface ServerProject {
  id: string;
  name: string;
  factCount: number;
  lastUpdated: number | null;
}

function mapProject(p: ServerProject): Project {
  return { path: p.id, name: p.name, factCount: p.factCount, lastUpdated: p.lastUpdated };
}

export async function listProjects(): Promise<Project[]> {
  requireEndpoint();
  const { data } = await listProjectsHttp();
  if (!data) throw new Error("项目列表加载失败");
  // Server rows are insertion-ordered; the reserved global project pins first
  // regardless of when it was seeded (same order the desktop mirror used).
  const rows = data.projects.map(mapProject);
  const globalIdx = rows.findIndex((p) => p.path === GLOBAL_PROJECT);
  if (globalIdx > 0) rows.unshift(...rows.splice(globalIdx, 1));
  return rows;
}

/** True when running inside the desktop shell (preload bridge present); the
 *  browser build has no window.knot and skips the desktop-only IPC calls. */
const hasDesktopBridge = () =>
  typeof (globalThis as { knot?: unknown }).knot !== "undefined";

/** Register a directory as a project. Desktop: IPC resolves the canonical path
 *  (realpath), wires the file watcher and kicks the one-time existing-content
 *  import; the service registry is then updated with the resolved path so the
 *  sidebar (served from GET /projects) shows it before the first ingest lands.
 *  Browser build: registry registration only (name derived from the path tail). */
export async function addProject(path: string): Promise<Project> {
  if (hasDesktopBridge()) {
    const project = await window.knot.invoke<Project>("add_project", path);
    requireEndpoint();
    const { error } = await registerProjectHttp({ body: { projectId: project.path } });
    if (error) throw error;
    return project;
  }
  requireEndpoint();
  const { data, error } = await registerProjectHttp({ body: { projectId: path } });
  if (error) throw error;
  if (!data) throw new Error("项目注册失败");
  return mapProject(data);
}

/** Remove a project and its facts. Server DELETE is the truth source (registry
 *  row + every fact in the vector store); desktop IPC additionally drops the
 *  mirror rows and the project's watch roots. */
export async function removeProject(path: string): Promise<void> {
  requireEndpoint();
  const { error } = await removeProjectHttp({ path: { projectId: path } });
  if (error) throw error;
  if (hasDesktopBridge()) await window.knot.invoke("remove_project", path);
}

// ---------- Facts ----------

interface ServerFact {
  id: string;
  memory: string;
  metadata?: Record<string, string> | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

function mapFact(projectId: string, f: ServerFact): Fact {
  return {
    id: f.id,
    projectId,
    content: f.memory,
    agent: f.metadata?.agent ?? "",
    type: f.metadata?.type ?? "",
    source: f.metadata?.source ?? "",
    // Null for pre-meta facts — the UI renders "-" (formatTime is never called on 0).
    createdAt: f.createdAt ?? null,
    updatedAt: f.updatedAt ?? null,
  };
}

export async function listFacts(projectId: string): Promise<Fact[]> {
  requireEndpoint();
  const { data } = await listFactsHttp({ path: { projectId } });
  if (!data) throw new Error("记忆列表加载失败");
  return data.facts.map((f) => mapFact(projectId, f));
}

export async function addFact(projectId: string, content: string): Promise<void> {
  requireEndpoint();
  const { error } = await addFactHttp({ body: { projectId, content } });
  if (error) throw error;
  await syncMirror(projectId);
}

export async function updateFact(
  id: string,
  projectId: string,
  content: string,
): Promise<void> {
  requireEndpoint();
  const { error } = await updateFactHttp({ path: { id }, body: { content } });
  if (error) throw error;
  await syncMirror(projectId);
}

export async function deleteFact(id: string, projectId: string): Promise<void> {
  requireEndpoint();
  const { error } = await deleteFactHttp({ path: { id } });
  if (error) throw error;
  await syncMirror(projectId);
}

// ---------- MCP config injection ----------
// Per-agent (claude-code / codex / hermes / joycode / workbuddy): writes each
// agent's user-level mcpServers config.

export type ConnectorAgent = "claude-code" | "codex" | "hermes" | "joycode" | "workbuddy";

export const injectMcp = (agent: ConnectorAgent) =>
  window.knot.invoke<string>("inject_mcp", agent);

export const removeMcp = (agent: ConnectorAgent) =>
  window.knot.invoke<string>("remove_mcp", agent);

export const mcpStatus = (agent: ConnectorAgent) =>
  window.knot.invoke<boolean>("mcp_status", agent);

// ---------- Settings (memory service connection) ----------

export interface LlmSettings {
  provider: "minimax" | "openai";
  baseUrl: string;
  model: string;
  embedModel: string;
  hasApiKey: boolean;
  /** Memory storage: "local" child service (default) or "remote" user-deployed
   *  instance of server/ — same HTTP client, only the address differs. */
  mode: "local" | "remote";
  remoteUrl: string;
  hasRemoteToken: boolean;
}

export const getSettings = () =>
  window.knot.invoke<LlmSettings>("get_settings");

/** Pass null for apiKey to keep the existing value; '' explicitly clears it.
 *  Same contract for remoteToken (only meaningful in remote mode). */
export const saveSettings = (
  baseUrl: string,
  apiKey: string | null,
  model: string,
  provider: "minimax" | "openai",
  embedModel?: string,
  mode?: "local" | "remote",
  remoteUrl?: string,
  remoteToken?: string | null,
) =>
  window.knot.invoke(
    "save_settings",
    baseUrl,
    apiKey,
    model,
    provider,
    embedModel,
    mode,
    remoteUrl,
    remoteToken,
  );

/** GET /health on a user-configured memory service (settings modal "测试连接"). */
export interface ConnectionTestResult {
  ok: boolean;
  ready?: boolean;
  embedSignature?: string;
  embedModel?: string;
  notice?: string;
  error?: string;
}

export const testMemoryConnection = (url: string, token: string | null) =>
  window.knot.invoke<ConnectionTestResult>("test_memory_connection", url, token);

// ---------- Last opened project ----------

export const getLastProject = () =>
  window.knot.invoke<string | null>("get_last_project");

export const setLastProject = (path: string) =>
  window.knot.invoke("set_last_project", path);

// ---------- Search history (per project, last 10; localStorage) ----------

export const getSearchHistory = (projectId: string) =>
  Promise.resolve(getSearchHistoryLocal(projectId));

/** Move query to the front of the project's history (dedupe, cap 10) and persist */
export const pushSearchHistory = (projectId: string, query: string) =>
  Promise.resolve(pushSearchHistoryLocal(projectId, query));

// ---------- Memory watch rules ----------

export interface WatchRule {
  id: string;
  agent: string;
  match: string;
  enabled: boolean;
  builtin?: boolean;
  /** Basenames treated as catalogs and never ingested; default ['MEMORY.md'], [] opts out */
  indexFiles?: string[];
}

export const getWatchRules = () =>
  window.knot.invoke<WatchRule[]>("get_watch_rules");

/** After saving, the main process rebuilds watchers immediately and imports existing content for new rules */
export const saveWatchRules = (rules: WatchRule[]) =>
  window.knot.invoke<WatchRule[]>("save_watch_rules", rules);

// ---------- Directory picker ----------

export const pickDirectory = () =>
  window.knot.invoke<string | null>("pick_directory");

// ---------- Semantic search (service /search) ----------

export interface SemanticHit {
  id: string;
  memory: string;
  /** Embedding cosine (0-1); absent when the semantic path was gated away. */
  semanticScore?: number;
  /** Negated BM25 (higher = better); absent on semantic-only hits. */
  kScore?: number;
  agent?: string;
  type?: string;
  source?: string;
  updatedAt?: number;
}

export async function searchMemories(
  projectId: string,
  query: string,
): Promise<SemanticHit[]> {
  requireEndpoint();
  const { data } = await searchMemoriesHttp({ body: { projectId, query } });
  if (!data) throw new Error("检索失败");
  return data.hits.map((h) => ({
    id: h.id,
    memory: h.memory,
    // Service score is the embedding cosine; the BM25 half of the old desktop
    // hybrid path lives in the main process (MCP search) — display search uses
    // the service's semantic ranking.
    semanticScore: h.score,
    agent: h.agent,
    type: h.type,
    source: h.source,
    updatedAt: h.updatedAt ?? undefined,
  }));
}

// ---------- External links ----------

export const openExternal = (url: string) =>
  window.knot.invoke("open_external", url);

// Open a local file with its default app (used by the memory card's source path)
export const openPath = (path: string) => window.knot.invoke("open_path", path);
