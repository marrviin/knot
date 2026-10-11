//! IPC handler layer: the bridge between renderer and main process
//! (counterpart of the original Tauri commands.rs).
//! Channel names map one-to-one to the invoke names in the renderer's api.ts.

import { ipcMain, dialog, BrowserWindow } from 'electron';

import * as store from './store';
import * as settings from './settings';
import * as inject from './inject';
import * as mem0 from './mem0';
import * as watcher from './watcher';

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

  ipcMain.handle('list_projects', () => ok(() => store.listProjects()));

  ipcMain.handle('add_project', async (_e, path: string) => {
    const fs = await import('node:fs');
    const resolved = fs.realpathSync(path);
    if (!fs.statSync(resolved).isDirectory()) return `目录不存在：${path}`;
    const isNew = store.insertProject(resolved);
    if (isNew) watcher.rescan();
    return store.listProjects().find((p) => p.path === resolved);
  });

  ipcMain.handle('remove_project', (_e, path: string) =>
    ok(() => {
      store.removeProject(path);
      // The corresponding chokidar watch stays in place, but ingest verifies the project is still registered first
    }),
  );

  // ---------- Facts ----------

  ipcMain.handle('list_facts', (_e, projectId: string) => ok(() => store.listFacts(projectId)));

  ipcMain.handle('add_fact', async (_e, projectId: string, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) throw new Error('记忆内容不能为空');
    const report = await mem0.addManualMemory(ctx.userDataDir, projectId, trimmed);
    ctx.onFactsChanged({ path: projectId, ...report });
  });

  ipcMain.handle('update_fact', async (_e, id: string, projectId: string, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) throw new Error('记忆内容不能为空');
    await mem0.updateMemory(ctx.userDataDir, id, trimmed);
    ctx.onFactsChanged({ path: projectId, added: 0 });
  });

  ipcMain.handle('delete_fact', async (_e, id: string, projectId: string) => {
    await mem0.removeMemory(id);
    ctx.onFactsChanged({ path: projectId, deleted: 1 });
    return null;
  });

  // ---------- MCP config injection ----------

  ipcMain.handle('inject_mcp', () => ok(() => inject.inject()));
  ipcMain.handle('remove_mcp', () => ok(() => inject.remove()));
  ipcMain.handle('mcp_status', () => ok(() => inject.isInjected()));

  // ---------- Settings ----------

  ipcMain.handle('get_settings', () =>
    ok(() => settings.view(settings.load(store))),
  );

  ipcMain.handle(
    'save_settings',
    (_e, enabled: boolean, baseUrl: string, apiKey: string | null, model: string) =>
      ok(() => {
        settings.save(store, enabled, baseUrl, apiKey, model);
      }),
  );

  // ---------- Remember last opened project ----------

  ipcMain.handle('get_last_project', () => ok(() => store.getSetting('last_project')));
  ipcMain.handle('set_last_project', (_e, path: string) =>
    ok(() => store.setSetting('last_project', path)),
  );

  // ---------- Memory watch rules ----------

  ipcMain.handle('get_watch_rules', () => ok(() => settings.loadWatchRules(store)));

  // Rebuild watchers immediately after saving, then one-time import existing content for new rules
  ipcMain.handle('save_watch_rules', async (_e, rules: settings.WatchRule[]) => {
    const saved = settings.saveWatchRules(store, rules);
    watcher.rescan();
    await watcher.importExisting((projectId, report) => {
      ctx.onFactsChanged({ path: projectId, ...report });
    });
    return saved;
  });

  // ---------- Semantic search (mem0) ----------

  ipcMain.handle(
    'semantic_search',
    async (_e, projectId: string, query: string) => {
      const q = query.trim();
      if (!q) throw new Error('查询不能为空');
      return mem0.semanticSearch(ctx.userDataDir, projectId, q);
    },
  );

  // ---------- Directory picker / legacy store migration ----------

  ipcMain.handle('pick_directory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('legacy_migration_available', () => ok(() => store.legacyDbHasFacts()));

  ipcMain.handle('migrate_legacy', async () => {
    const report = await mem0.migrateLegacy(ctx.userDataDir);
    ctx.onFactsChanged({ path: '', ...report, refreshAll: true });
    return report;
  });
}
