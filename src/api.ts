/** Renderer API layer: talks to the main process via window.knot exposed by the preload.
 *  (Migrated from Tauri invoke; channel names map one-to-one to electron/ipc.ts.) */

import type { Fact, Project } from './types';

declare global {
  interface Window {
    knot: {
      invoke: <T = void>(command: string, ...args: unknown[]) => Promise<T>;
      listen: (event: string, cb: (payload: any) => void) => () => void;
      getPathForFile: (file: File) => string;
    };
  }
}

// ---------- Projects ----------

/** Reserved path of the global-memory virtual project (created by the main process,
 *  pinned first, not removable); agent-level memories like hermes's land here */
export const GLOBAL_PROJECT = '__global__';

export const listProjects = () => window.knot.invoke<Project[]>('list_projects');

export const addProject = (path: string) => window.knot.invoke<Project>('add_project', path);

export const removeProject = (path: string) => window.knot.invoke('remove_project', path);

// ---------- Facts ----------

export const listFacts = (projectId: string) => window.knot.invoke<Fact[]>('list_facts', projectId);

export const addFact = (projectId: string, content: string) =>
  window.knot.invoke('add_fact', projectId, content);

export const updateFact = (id: string, projectId: string, content: string) =>
  window.knot.invoke('update_fact', id, projectId, content);

export const deleteFact = (id: string, projectId: string) =>
  window.knot.invoke('delete_fact', id, projectId);

// ---------- MCP config injection ----------

export const injectMcp = () => window.knot.invoke<string>('inject_mcp');

export const removeMcp = () => window.knot.invoke<string>('remove_mcp');

export const mcpStatus = () => window.knot.invoke<boolean>('mcp_status');

// ---------- Settings (core extraction-layer LLM config) ----------

export interface LlmSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export const getSettings = () => window.knot.invoke<LlmSettings>('get_settings');

/** Pass null for apiKey to keep the existing value; '' explicitly clears it */
export const saveSettings = (
  enabled: boolean,
  baseUrl: string,
  apiKey: string | null,
  model: string,
) => window.knot.invoke('save_settings', enabled, baseUrl, apiKey, model);

// ---------- Last opened project ----------

export const getLastProject = () => window.knot.invoke<string | null>('get_last_project');

export const setLastProject = (path: string) => window.knot.invoke('set_last_project', path);

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

export const getWatchRules = () => window.knot.invoke<WatchRule[]>('get_watch_rules');

/** After saving, the main process rebuilds watchers immediately and imports existing content for new rules */
export const saveWatchRules = (rules: WatchRule[]) =>
  window.knot.invoke<WatchRule[]>('save_watch_rules', rules);

// ---------- Directory picker / legacy store migration ----------

export const pickDirectory = () => window.knot.invoke<string | null>('pick_directory');

export const legacyMigrationAvailable = () =>
  window.knot.invoke<boolean>('legacy_migration_available');

export interface MigrateReport {
  added: number;
  updated: number;
  deleted: number;
}

export const migrateLegacy = () => window.knot.invoke<MigrateReport>('migrate_legacy');

// ---------- mem0 semantic search ----------

export interface SemanticHit {
  id: string;
  memory: string;
  score: number;
  agent?: string;
  type?: string;
  source?: string;
  updatedAt?: number;
}

export const searchMemories = (projectId: string, query: string) =>
  window.knot.invoke<SemanticHit[]>('semantic_search', projectId, query);

// ---------- External links ----------

export const openExternal = (url: string) => window.knot.invoke('open_external', url);

// Open a local file with its default app (used by the memory card's source path)
export const openPath = (path: string) => window.knot.invoke('open_path', path);
