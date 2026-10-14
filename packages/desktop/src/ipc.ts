//! IPC handler layer: the bridge between renderer and main process
//! (counterpart of the original Tauri commands.rs).
//! Channel names map one-to-one to the invoke names in the renderer's api.ts.

import { ipcMain, dialog, BrowserWindow, shell } from "electron";

import * as store from "./store";
import * as settings from "./settings";
import * as inject from "./inject";
import * as mem0 from "./mem0";
import * as watcher from "./watcher";
import * as mcpServer from "./mcp-server";
import { createOrShowSettingsWindow, closeSettingsWindow } from "./settings-window";
import { log } from "./log";

export interface IpcContext {
  userDataDir: string;
  onFactsChanged: (payload: Record<string, unknown>) => void;
}

export function registerIpc(ctx: IpcContext): void {
  const ok = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      throw new Error(String(e));
    }
  };

  // ---------- Memory service endpoint (renderer-direct HTTP) ----------

  // Display + facts CRUD now go renderer → service over HTTP (generated hey-api
  // client); this hands the renderer the child process's loopback base + token.
  // Re-invoking retries the lazy spawn, so the renderer can re-bootstrap after
  // settings changes without an app restart.
  ipcMain.handle("memory_endpoint", async () => {
    const conn = await mem0.ensureMemory(ctx.userDataDir);
    if (!conn) throw new Error("记忆服务未连接（未启用或未配置）");
    return { base: conn.base, token: conn.token };
  });

  // Mirror reconciliation after a renderer-direct HTTP mutation: the local
  // mirror store (MCP keyword search + hybrid search read it) must track the
  // service's truth. restoreMirror is a pure sync (facts diff, no LLM).
  ipcMain.handle("sync_mirror", (_e, projectId: string) =>
    ok(() => mem0.restoreMirror(projectId)),
  );

  // ---------- Standalone settings window ----------

  // Open (or focus the existing) settings window. The sender window is the main
  // window — it receives knot://settings-closed when the settings window closes.
  ipcMain.handle("open_settings", (e) => {
    const mainWin = BrowserWindow.fromWebContents(e.sender);
    if (!mainWin) throw new Error("主窗口不可用");
    createOrShowSettingsWindow(mainWin);
  });

  ipcMain.handle("close_settings", () => ok(() => closeSettingsWindow()));

  // ---------- Projects ----------

  ipcMain.handle("add_project", async (_e, path: string) => {
    log(`add_project: 收到路径 ${path}`);
    try {
      const fs = await import("node:fs");
      const resolved = fs.realpathSync(path);
      if (!fs.statSync(resolved).isDirectory()) {
        // Throw (not return a string): the renderer would otherwise treat the
        // string as a Project object and toast a fake "已接管项目「undefined」".
        throw new Error(`目录不存在：${path}`);
      }
      const isNew = store.insertProject(resolved);
      log(`add_project: resolved=${resolved} isNew=${isNew}`);
      if (isNew) {
        watcher.rescan();
        // One-time import of the new project's existing content (markers skip
        // already-imported targets). Fire-and-forget: it's minutes of LLM calls —
        // the IPC must return so the panel mounts and progress events can show.
        void watcher
          .importExisting((projectId, report) => {
            ctx.onFactsChanged({ path: projectId, ...report });
          })
          .catch((e) => log(`add_project 存量导入失败: ${e}`));
      }
      const project = store.listProjects().find((p) => p.path === resolved);
      if (!project) throw new Error(`项目注册失败：${resolved}`);
      return project;
    } catch (e) {
      log(`add_project 失败: ${e}`);
      throw new Error(String(e));
    }
  });

  ipcMain.handle("remove_project", (_e, path: string) =>
    ok(() => {
      store.removeProject(path);
      // Drop the removed project's watch roots from chokidar right away instead of
      // leaving them matched-and-discarded on every change until the next rescan.
      watcher.rescan();
    }),
  );

  // ---------- Facts ----------
  // No IPC handlers: the renderer calls the memory service directly over HTTP
  // (api.ts → hey-api client) and follows up with sync_mirror so this process's
  // local mirror stays aligned for MCP keyword search.

  // ---------- MCP config injection ----------
  // One set of channels per target agent (claude-code / codex / hermes / joycode /
  // workbuddy): the agent id is validated by inject.asAgent, so an unknown id
  // throws before touching any file.

  ipcMain.handle("inject_mcp", (_e, agent: unknown) =>
    ok(() => inject.inject(inject.asAgent(agent))),
  );
  ipcMain.handle("remove_mcp", (_e, agent: unknown) =>
    ok(() => inject.remove(inject.asAgent(agent))),
  );
  ipcMain.handle("mcp_status", (_e, agent: unknown) =>
    ok(() => inject.isInjected(inject.asAgent(agent))),
  );

  // ---------- Settings ----------

  ipcMain.handle("get_settings", () =>
    ok(() => settings.view(settings.load(store))),
  );

  ipcMain.handle(
    "save_settings",
    (
      _e,
      baseUrl: string,
      apiKey: string | null,
      model: string,
      provider: "minimax" | "openai",
      mode?: "local" | "remote",
      remoteUrl?: string,
      remoteToken?: string | null,
    ) =>
      ok(() => {
        settings.save(store, baseUrl, apiKey, model, provider, mode, remoteUrl, remoteToken);
        // Any settings save takes effect immediately: rebuild watchers and import
        // pending existing content — no app restart needed. Fire-and-forget: the
        // import is minutes of embedding calls; progress events drive the UI.
        watcher.rescan();
        void watcher
          .importExisting((projectId, report) => {
            ctx.onFactsChanged({ path: projectId, ...report });
          })
          .catch((e) => log(`save_settings 触发的存量导入失败: ${e}`));
        // Embeddings always run on the bundled local model, so a settings save can
        // no longer change the embedding space (and invalidate stored vectors).
        return undefined;
      }),
  );

  // ---------- Saved model library (multiple configs, one active) ----------

  // Applying a model config to the active llm_* scalars + hot reload. Shared by
  // activate_model and by save_model when the edited entry is the active one.
  const applyLlmConfig = (
    apiKey: string | null,
    entry: { provider: "minimax" | "openai"; baseUrl: string; model: string },
  ): void => {
    settings.save(store, entry.baseUrl, apiKey, entry.model, entry.provider);
    // Same take-effect-immediately contract as save_settings (no app restart).
    watcher.rescan();
    void watcher
      .importExisting((projectId, report) => {
        ctx.onFactsChanged({ path: projectId, ...report });
      })
      .catch((e) => log(`模型切换触发的存量导入失败: ${e}`));
  };

  ipcMain.handle("list_models", () =>
    ok(() => {
      const models = settings.loadModels(store);
      return {
        models: models.map((m) => ({
          id: m.id,
          provider: m.provider,
          baseUrl: m.baseUrl,
          model: m.model,
          hasApiKey: !!m.apiKey,
        })),
        activeId: settings.activeIdOf(store, models),
      };
    }),
  );

  ipcMain.handle(
    "save_model",
    (
      _e,
      entry: { id?: string; provider: "minimax" | "openai"; baseUrl: string; model: string },
      apiKey: string | null | undefined,
    ) =>
      ok(() => {
        const beforeActiveId = settings.activeIdOf(store, settings.loadModels(store));
        const saved = settings.saveModel(store, {
          ...entry,
          // undefined = keep the stored key (field untouched); '' = clear; non-empty = replace.
          apiKey: apiKey === undefined ? undefined : (apiKey ?? ""),
        });
        // Editing the active entry applies it immediately (same contract as save_settings);
        // adding/editing an inactive entry only touches the library.
        if (saved.id === beforeActiveId) {
          return {
            model: { ...saved, apiKey: undefined, hasApiKey: !!saved.apiKey },
            activeId: saved.id,
            notice: (applyLlmConfig(saved.apiKey || null, saved), undefined),
          };
        }
        return {
          model: { ...saved, apiKey: undefined, hasApiKey: !!saved.apiKey },
          activeId: beforeActiveId,
          notice: undefined,
        };
      }),
  );

  ipcMain.handle("delete_model", (_e, id: string) =>
    ok(() => {
      settings.deleteModel(store, id);
    }),
  );

  ipcMain.handle("activate_model", (_e, id: string) =>
    ok(() => {
      const entry = settings.loadModels(store).find((m) => m.id === id);
      if (!entry) throw new Error("模型配置不存在");
      return {
        activeId: settings.activeIdOf(store, settings.loadModels(store)),
        notice: (applyLlmConfig(entry.apiKey || null, entry), undefined),
      };
    }),
  );

  // ---------- Remote memory service connection test (settings modal) ----------

  // GET /health on a user-configured service: surfaces reachability + the server's
  // embedding identity so a vector-space mismatch is visible before switching.
  ipcMain.handle(
    "test_memory_connection",
    async (_e, url: string, token: string | null) => {
      const base = url.trim().replace(/\/+$/, "");
      if (!base) return { ok: false, error: "请先填写服务地址" };
      try {
        const resp = await fetch(`${base}/health`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          signal: AbortSignal.timeout(5000),
        });
        const j = (await resp.json().catch(() => ({}))) as {
          ready?: boolean;
          embedSignature?: string;
          embedModel?: string;
          notice?: string;
          message?: string;
        };
        if (!resp.ok) return { ok: false, error: j.message ?? `HTTP ${resp.status}` };
        return {
          ok: true,
          ready: !!j.ready,
          embedSignature: j.embedSignature,
          embedModel: j.embedModel,
          notice: j.notice,
        };
      } catch (e) {
        return { ok: false, error: `无法连接 ${base}：${e}` };
      }
    },
  );

  // ---------- Remember last opened project ----------

  ipcMain.handle("get_last_project", () =>
    ok(() => store.getSetting("last_project")),
  );
  ipcMain.handle("set_last_project", (_e, path: string) =>
    ok(() => store.setSetting("last_project", path)),
  );

  // ---------- Memory watch rules ----------

  ipcMain.handle("get_watch_rules", () =>
    ok(() => settings.loadWatchRules(store)),
  );

  // Rebuild watchers immediately after saving, then one-time import existing content for new rules.
  // Rules are saved synchronously before the import, so an import failure (reported to
  // the renderer via the import-progress done notice) doesn't lose the user's changes.
  ipcMain.handle(
    "save_watch_rules",
    async (_e, rules: settings.WatchRule[]) => {
      const saved = settings.saveWatchRules(store, rules);
      watcher.rescan();
      try {
        await watcher.importExisting((projectId, report) => {
          ctx.onFactsChanged({ path: projectId, ...report });
        });
      } catch (e) {
        log(`save_watch_rules 触发的存量导入失败: ${e}`);
      }
      return saved;
    },
  );

  // ---------- Semantic search (mem0) ----------

  ipcMain.handle(
    "semantic_search",
    async (_e, projectId: string, query: string) => {
      const q = query.trim();
      if (!q) throw new Error("查询不能为空");
      // Same hybrid retrieval as the MCP tool (BM25 + semantic, fused, same gates)
      // so the GUI never shows different results than what the model sees.
      const hits = await mcpServer.hybridSearch(projectId, q);
      return hits.map((h) => ({ ...h, memory: h.content }));
    },
  );

  // ---------- Directory picker / legacy store migration ----------

  ipcMain.handle("pick_directory", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });

  // ---------- Open links in the system browser ----------

  ipcMain.handle("open_external", (_e, url: string) =>
    ok(() => {
      if (typeof url !== "string" || !/^https:\/\//.test(url)) {
        throw new Error(`不允许打开的链接：${url}`);
      }
      shell.openExternal(url);
    }),
  );

  // Open a local file (e.g. a memory card's source path) with its default app
  ipcMain.handle("open_path", (_e, path: string) =>
    ok(async () => {
      if (typeof path !== "string" || !path.startsWith("/")) {
        throw new Error(`不允许打开的路径：${path}`);
      }
      const err = await shell.openPath(path);
      if (err) throw new Error(err);
    }),
  );
}
