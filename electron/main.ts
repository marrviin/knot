//! Electron main process entry.
//! - `knot --mcp-server`: headless stdio MCP server (spawned by Claude Code)
//! - Default: GUI main window + file watching + auto discovery + mem0 integration

import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';

import * as store from './store';
import * as mem0 from './mem0';
import * as watcher from './watcher';
import { discoverClaudeProjects } from './discover';
import { registerIpc } from './ipc';
import { runMcpServer } from './mcp-server';

if (process.argv.includes('--mcp-server')) {
  app.whenReady().then(() => {
    store.open(app.getPath('userData'));
    runMcpServer();
  });
} else {
  void startGui();
}

/** Tray icon and main window references; `quitting` distinguishes Cmd+Q/tray quit from clicking the close button */
let tray: Tray | null = null;
let appQuitting = false;

async function startGui(): Promise<void> {
  await app.whenReady();

  // macOS: in dev mode the Dock shows the default Electron icon; set it to build/icon.png
  // manually. After packaging the app bundle's own icon takes over, so this is harmless.
  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'build', 'icon.png'));
    if (!icon.isEmpty()) app.dock.setIcon(icon);
    else console.warn('[Knot] 未找到应用图标 build/icon.png，Dock 使用默认图标');
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: '结绳 Knot',
    // macOS: no native title bar row; traffic lights overlay the content's top-left
    // (matching manta-compare's Overlay style). Other platforms keep the default title bar.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          // trafficLightPosition is the top-left corner of the buttons (12px diameter):
          // y=(48-12)/2=18 centers the lights vertically in the 48px sidebar drag strip,
          // aligned with the Knot title; the light bottom (y=30) leaves 18px above the
          // "Add project" menu below (y=48).
          trafficLightPosition: { x: 16, y: 18 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Traffic lights/close button → hide to tray instead of quitting; Cmd+Q or tray "Quit" actually quits
  app.on('before-quit', () => {
    appQuitting = true;
  });
  win.on('close', (e) => {
    if (!appQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  // Restore the window when clicking the Dock icon on macOS
  app.on('activate', () => {
    win.show();
  });

  createTray(win);

  const userDataDir = app.getPath('userData');
  store.open(userDataDir);
  migrateLegacySettings();
  watcher.setUserDataDir(userDataDir);

  const onFactsChanged = (payload: Record<string, unknown>) => {
    win.webContents.send('knot://facts-changed', payload);
  };
  watcher.setIngestListener((projectId, report) => {
    onFactsChanged({ path: projectId, ...report });
  });

  registerIpc({ userDataDir, onFactsChanged });

  // Load the Vite dev server in dev mode; load built assets after packaging
  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Lazily initialize mem0 (connect only when configured), then resume watching + auto discovery
  void (async () => {
    await mem0.ensureMemory(userDataDir);

    watcher.rescan();

    const discoverLoop = async () => {
      let discoveredNew = false;
      for (const p of discoverClaudeProjects()) {
        if (store.insertProject(p)) {
          console.log('[Knot Discover] 自动接管项目', p);
          discoveredNew = true;
        }
      }
      if (discoveredNew) {
        win.webContents.send('knot://projects-changed', null);
        watcher.rescan();
      }
      await watcher.importExisting((projectId, report) => {
        onFactsChanged({ path: projectId, ...report });
      });
    };
    void discoverLoop();
    setInterval(() => void discoverLoop(), 60_000);
  })();

  app.on('window-all-closed', () => {
    watcher.unwatchAll();
    mem0.shutdown();
    app.quit();
  });
}

/** Menu bar tray: left-click opens the main window, right-click pops the menu (Show / Quit) */
function createTray(win: BrowserWindow): void {
  // tray-template.png is a template image (black + alpha); macOS auto-adapts it to
  // menu bar light/dark appearance. createFromPath picks up sibling @2x/@3x HiDPI variants.
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'build', 'tray', 'tray-template.png'));
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('结绳 Knot');

  const menu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => showMainWindow(win),
    },
    { type: 'separator' },
    {
      label: '退出 Knot',
      click: () => app.quit(),
    },
  ]);

  tray.on('click', () => showMainWindow(win));
  tray.on('right-click', () => tray?.popUpContextMenu(menu));
}

function showMainWindow(win: BrowserWindow): void {
  win.show();
  win.focus();
}

/** Carry over LLM settings from the legacy Tauri app if any (never overwrites existing config in the new store) */
function migrateLegacySettings(): void {
  if (store.getSetting('llm_api_key')) return;
  const legacy = store.readLegacySettings();
  for (const key of ['llm_enabled', 'llm_base_url', 'llm_model', 'llm_api_key']) {
    if (legacy[key]) store.setSetting(key, legacy[key]);
  }
}
