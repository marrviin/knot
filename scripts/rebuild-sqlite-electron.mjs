//! `pnpm install` compiles better-sqlite3 against the Node ABI, but Electron
//! needs a different ABI. This script pulls the Electron prebuilt binary
//! via prebuild-install.
//! Usage: pnpm rebuild:electron (run once before dev / start)

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('better-sqlite3/package.json'));
const electronVersion = JSON.parse(
  fs.readFileSync(path.join('node_modules', 'electron', 'package.json'), 'utf-8'),
).version;

const r = spawnSync(
  path.join(pkgDir, 'node_modules', '.bin', 'prebuild-install'),
  ['-r', 'electron', '-t', electronVersion],
  { cwd: pkgDir, stdio: 'inherit' },
);
if (r.status !== 0) {
  console.error(`[rebuild:electron] prebuild-install 失败（status ${r.status}），` +
    '可改用源码编译：cd node_modules/better-sqlite3 && npx @electron/rebuild');
  process.exit(r.status ?? 1);
}
console.log(`[rebuild:electron] better-sqlite3 已切换到 Electron ${electronVersion} ABI`);
