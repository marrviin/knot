//! One-shot headless import: reuses the GUI-side watch-rule import logic
//! (watcher.importExisting) and reads/writes the real store under
//! ~/Library/Application Support/journal directly.
//! How to run (better-sqlite3 is compiled against the Electron ABI, so Electron's Node is required):
//!   npx esbuild scripts/import-once.ts --bundle --platform=node --format=cjs \
//!     --outfile=dist-electron/import-once.cjs --external:better-sqlite3 --external:mem0ai --external:chokidar
//!   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron dist-electron/import-once.cjs

import os from 'node:os';
import path from 'node:path';

import * as store from '../electron/store';
import * as mem0 from '../electron/mem0';
import * as watcher from '../electron/watcher';

const userDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'journal');

void (async () => {
  store.open(userDataDir);
  const m = await mem0.ensureMemory(userDataDir);
  if (!m) {
    console.error('[Journal Import] LLM 未配置，退出');
    process.exit(1);
  }

  await watcher.importExisting((projectId, report) => {
    console.log(`[Journal Import] ${projectId}: added=${report.added} updated=${report.updated} deleted=${report.deleted}${report.notice ? ` (${report.notice})` : ''}`);
  });

  console.log('[Journal Import] 完成');
  process.exit(0);
})();
