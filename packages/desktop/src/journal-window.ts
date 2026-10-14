//! Standalone journal-book window: the project's diary rendered as a flippable
//! paper book. A singleton BrowserWindow loading the same renderer as the main
//! window — the URL query `?window=journal&project=…&date=…` makes the entry
//! render the book instead of the app shell (same pattern as ?window=settings).
//! The generic preload surface (invoke/listen) is window-agnostic. Re-opening
//! from another card while the window is up re-targets the running book via
//! journal://book-open instead of recreating the window.

import { BrowserWindow } from 'electron';
import path from 'node:path';

let journalWin: BrowserWindow | null = null;

/** Close the book window if it's up (the main window calls this on focus:
 * clicking back into the app shell dismisses the floating book). */
export function closeJournalWindow(): void {
  if (journalWin && !journalWin.isDestroyed()) journalWin.close();
}

/** Create (or focus + retarget) the singleton journal-book window. */
export function createOrShowJournalWindow(project: string, date: string): void {
  if (journalWin && !journalWin.isDestroyed()) {
    journalWin.show();
    journalWin.focus();
    // A different card clicked while the book is already open: tell the running
    // renderer to turn to that day (it reloads entries if the project changed).
    journalWin.webContents.send('journal://book-open', { project, date });
    return;
  }

  journalWin = new BrowserWindow({
    // Fixed book size: the renderer's pages are hard-coded to the book's
    // dimensions, so the window doesn't resize.
    width: 1000,
    height: 740,
    resizable: false,
    fullscreenable: false,
    title: '日记本',
    show: false,
    // Transparent window: only the book floats over the user's desktop — the
    // desk backdrop lives in CSS (.jnb-desk) and must stay see-through too.
    // Native shadow is off (a transparent window would shadow the full
    // rectangle); the book carries its own box-shadow (.jnb-base).
    transparent: true,
    hasShadow: false,
    // macOS: same hidden-inset look as the other windows; the lights float over
    // the desk backdrop. Other platforms keep the native title bar.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          // Keep the inset layout but drop the buttons themselves — the book
          // floats over the desktop with no chrome at all.
          trafficLightOptions: { hideButtons: true } as const,
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  journalWin.once('ready-to-show', () => journalWin?.show());
  // Belt and suspenders: trafficLightOptions.hideButtons alone has been seen to
  // lose effect (macOS re-shows the buttons on some show/restore paths), so
  // re-hide them on every show. No-op/throw on unsupported platforms is fine —
  // the constructor option already covers those.
  const hideTrafficLights = (): void => {
    try {
      journalWin?.setWindowButtonVisibility(false);
    } catch {
      // constructor option handles it there
    }
  };
  journalWin.on('show', hideTrafficLights);
  hideTrafficLights();
  journalWin.on('closed', () => {
    journalWin = null;
  });

  // Same renderer, different window kind — the entry reads ?window=journal.
  const query = { window: 'journal', project, date };
  if (process.env.VITE_DEV_SERVER_URL) {
    const qs = new URLSearchParams(query).toString();
    void journalWin.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${qs}`);
  } else {
    void journalWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
      query,
    });
  }
}
