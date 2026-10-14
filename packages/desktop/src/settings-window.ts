//! Standalone settings window (WorkBuddy-style): a singleton BrowserWindow loading
//! the same renderer as the main window — the URL query `?window=settings` makes the
//! renderer's entry render the settings shell instead of the app shell. The generic
//! preload surface (invoke/listen) is window-agnostic, so every settings IPC keeps
//! working unchanged.

import { BrowserWindow } from 'electron';
import path from 'node:path';

let settingsWin: BrowserWindow | null = null;

/** Create (or focus) the singleton settings window. `mainWin` is only used to be
 *  notified when the settings window closes (knot://settings-closed → the main
 *  window re-connects the memory service, the equivalent of the old modal's
 *  onClose hook). */
export function createOrShowSettingsWindow(mainWin: BrowserWindow): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 720,
    minHeight: 520,
    title: '设置',
    show: false,
    // macOS: same hidden-inset look as the main window; the lights sit vertically
    // centered in the renderer's 54px header strip (y=(54-12)/2=21). Other platforms
    // keep the native title bar with its own close button.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 21 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  settingsWin.once('ready-to-show', () => settingsWin?.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
    if (!mainWin.isDestroyed()) {
      mainWin.webContents.send('knot://settings-closed');
    }
  });

  // Same renderer, different window kind — the entry reads ?window=settings.
  if (process.env.VITE_DEV_SERVER_URL) {
    void settingsWin.loadURL(`${process.env.VITE_DEV_SERVER_URL}?window=settings`);
  } else {
    void settingsWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
      query: { window: 'settings' },
    });
  }
}

export function closeSettingsWindow(): void {
  settingsWin?.close();
}
