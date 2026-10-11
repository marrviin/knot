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
  // Electron 新版本（如 v44 / ABI 149）的预编译包可能尚未发布，回退到源码编译
  console.error(`[rebuild:electron] prebuild-install 未找到 Electron ${electronVersion} 预编译包，改用源码编译…`);
  const rebuild = spawnSync(
    path.join('node_modules', '.bin', 'electron-rebuild'),
    ['-f', '-w', 'better-sqlite3'],
    { stdio: 'inherit' },
  );
  if (rebuild.status !== 0) {
    console.error(`[rebuild:electron] @electron/rebuild 源码编译失败（status ${rebuild.status}）`);
    process.exit(rebuild.status ?? 1);
  }
}
console.log(`[rebuild:electron] better-sqlite3 已切换到 Electron ${electronVersion} ABI`);
