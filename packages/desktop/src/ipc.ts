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

  // ---------- Projects ----------

  ipcMain.handle("list_projects", () => ok(() => store.listProjects()));

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

  ipcMain.handle("list_facts", (_e, projectId: string) =>
    ok(() => store.listFacts(projectId)),
  );

  ipcMain.handle("add_fact", async (_e, projectId: string, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) throw new Error("记忆内容不能为空");
    const report = await mem0.addManualMemory(
      ctx.userDataDir,
      projectId,
      trimmed,
    );
    ctx.onFactsChanged({ path: projectId, ...report });
  });

  ipcMain.handle(
    "update_fact",
    async (_e, id: string, projectId: string, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) throw new Error("记忆内容不能为空");
      // updateMemory throws when mem0 fails — the mirror must not diverge from the
      // truth source (a diverged "success" resurrects old content on the next sync).
      await mem0.updateMemory(ctx.userDataDir, id, trimmed);
      ctx.onFactsChanged({ path: projectId, added: 0 });
    },
  );

  ipcMain.handle("delete_fact", async (_e, id: string, projectId: string) => {
    await mem0.removeMemory(ctx.userDataDir, id);
    ctx.onFactsChanged({ path: projectId, deleted: 1 });
    return null;
  });

  // ---------- MCP config injection ----------
  // One set of channels per target agent (claude-code / joycode): the agent id is
  // validated by inject.asAgent, so an unknown id throws before touching any file.

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
      enabled: boolean,
      baseUrl: string,
      apiKey: string | null,
      model: string,
      provider: "minimax" | "openai",
      embedModel?: string,
      mode?: "local" | "remote",
      remoteUrl?: string,
      remoteToken?: string | null,
    ) =>
      ok(() => {
        const beforeLoad = settings.load(store);
        const before = settings.embedSignature(beforeLoad);
        settings.save(
          store,
          enabled,
          baseUrl,
          apiKey,
          model,
          provider,
          embedModel,
          mode,
          remoteUrl,
          remoteToken,
        );
        const afterLoad = settings.load(store);
        const after = settings.embedSignature(afterLoad);
        // Enabling (or reconfiguring) takes effect immediately: rebuild watchers and
        // import pending existing content — no app restart needed. Fire-and-forget:
        // the import is minutes of LLM calls; progress events drive the UI.
        if (enabled) {
          watcher.rescan();
          void watcher
            .importExisting((projectId, report) => {
              ctx.onFactsChanged({ path: projectId, ...report });
            })
            .catch((e) => log(`save_settings 触发的存量导入失败: ${e}`));
        }
        // A changed embedding model invalidates every stored vector: old memories
        // become unsearchable in the semantic path until the store is rebuilt.
        // Remote mode skips this — vectors live on the service, which warns on
        // its own logs (the client only holds the mirror).
        if (mode !== "remote" && before !== after) {
          return `配置已保存。注意：Embedding 模型已变更（${before} → ${after}），已存的记忆向量与新空间不匹配，语义检索将暂时不可用；建议清空记忆后重新导入。`;
        }
        return undefined;
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

  // ---------- Search history (per project, renderer search box) ----------

  ipcMain.handle("get_search_history", (_e, projectId: string) =>
    ok(() => store.getSearchHistory(projectId)),
  );
  ipcMain.handle("push_search_history", (_e, projectId: string, query: string) =>
    ok(() => store.pushSearchHistory(projectId, query)),
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
