//! Preload: exposes main-process capabilities through a minimal adapter surface,
//! keeping the migration cost for the renderer's api.ts (from Tauri) as low as possible.

import { contextBridge, ipcRenderer } from 'electron';
import { webUtils } from 'electron';

contextBridge.exposeInMainWorld('journal', {
  /** Maps to Tauri invoke(command, args); rejects when the main process throws */
  invoke: (command: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(command, ...args),

  /** Maps to Tauri listen(event, cb) */
  listen: (event: string, cb: (payload: any) => void): (() => void) => {
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },

  /** Dropped File object from drag-and-drop → local absolute path */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
});
