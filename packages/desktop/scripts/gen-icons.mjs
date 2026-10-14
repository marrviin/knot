// 从 build/icon.png 重新生成打包图标：
//   build/icon.icns  electron-builder mac.icon（sips + iconutil）
// 用法：cd packages/desktop && node scripts/gen-icons.mjs
// 换图标时只需替换 build/icon.png 后重跑本脚本。
// 注意：build/tray/ 下的托盘图标是手工资源，本脚本不动它们。

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcIcon = path.join(desktopRoot, 'build', 'icon.png');

// sharp 是 transformers 的传递依赖（pnpm 不提升），经由它的解析路径取用
function loadSharp() {
  try {
    return createRequire(import.meta.url)('sharp');
  } catch {
    const transformersRequire = createRequire(import.meta.resolve('@huggingface/transformers'));
    return transformersRequire('sharp');
  }
}

async function genIcns() {
  const meta = await loadSharp()(srcIcon).metadata();
  if ((meta.width ?? 0) < 512 || (meta.height ?? 0) < 512)
    throw new Error(`build/icon.png 至少 512x512，当前 ${meta.width}x${meta.height}`);

  const work = mkdtempSync(path.join(tmpdir(), 'journal-icons-'));
  const iconset = path.join(work, 'icon.iconset');
  execFileSync('mkdir', ['-p', iconset]);
  try {
    // Apple iconset 规定的 10 个尺寸
    const entries = [
      ['icon_16x16.png', 16],
      ['icon_16x16@2x.png', 32],
      ['icon_32x32.png', 32],
      ['icon_32x32@2x.png', 64],
      ['icon_128x128.png', 128],
      ['icon_128x128@2x.png', 256],
      ['icon_256x256.png', 256],
      ['icon_256x256@2x.png', 512],
      ['icon_512x512.png', 512],
      ['icon_512x512@2x.png', 1024],
    ];
    for (const [name, size] of entries) {
      execFileSync('sips', ['-z', String(size), String(size), srcIcon, '--out', path.join(iconset, name)], { stdio: 'pipe' });
    }
    const out = path.join(desktopRoot, 'build', 'icon.icns');
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', out], { stdio: 'pipe' });
    console.log(`✔ build/icon.icns 已生成（源图 ${meta.width}x${meta.height}）`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await genIcns();
