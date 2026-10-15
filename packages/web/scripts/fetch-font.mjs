//! One-shot asset fetcher: downloads the bundled handwriting font
//! (LXGW WenKai Lite, 分片 woff2 + unicode-range CSS) into
//! packages/web/src/assets/fonts/lxgw-wenkai-lite/. Idempotent — an existing
//! complete checkout is kept. Run once at setup; the artifacts are committed
//! so builds never need network.
//!
//!   node scripts/fetch-font.mjs [--refresh]
//!
//! --refresh re-downloads even when files already exist. npmmirror first
//! (reachable from CN networks); npmjs registry as fallback.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = 'lxgw-wenkai-lite-webfont';
// registry tarball endpoints, tried in order (npmmirror is CN-friendly)
const REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];

const refresh = process.argv.includes('--refresh');
const outDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'assets',
  'fonts',
  'lxgw-wenkai-lite',
);

/** The packaged font is a browser-webfont build: per-weight css files declaring
 *  @font-face chunks (unicode-range split) plus the woff2 files they reference.
 *  We ship exactly two weights of the kaiti variant — regular (400, body text)
 *  and bold (700, **强调**) — concatenated into font.css; the monolite variant
 *  and the light weight are skipped to keep the repo lean. */
const CSS_WEIGHTS = ['lxgwwenkailite-regular.css', 'lxgwwenkailite-bold.css'];

async function main() {
  const marker = path.join(outDir, 'package.json');
  if (!refresh && fs.existsSync(marker)) {
    console.log(`已有 ${outDir}，跳过（--refresh 可重新下载）`);
    return;
  }
  let ok = false;
  let lastErr = null;
  for (const registry of REGISTRIES) {
    try {
      console.log(`查询 ${registry}/${PKG} …`);
      const metaResp = await fetch(`${registry}/${PKG}/latest`, { redirect: 'follow' });
      if (!metaResp.ok) throw new Error(`HTTP ${metaResp.status}`);
      const meta = await metaResp.json();
      const tarball = meta.dist.tarball;
      console.log(`下载 ${tarball}`);
      const tgzResp = await fetch(tarball, { redirect: 'follow' });
      if (!tgzResp.ok) throw new Error(`HTTP ${tgzResp.status}`);
      const tgz = Buffer.from(await tgzResp.arrayBuffer());
      if (tgz.length < 10_000) throw new Error(`tarball 过小（${tgz.length}B）— 可能是错误页`);

      //Untar with the system tar (npm packs gzipped tarballs; no node dep needed).
      // tmp lives OUTSIDE outDir — the copy step below rm -rf's outDir first.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-font-'));
      fs.writeFileSync(path.join(tmp, 'pkg.tgz'), tgz);
      const { execSync } = await import('node:child_process');
      execSync(`tar -xzf pkg.tgz`, { cwd: tmp, stdio: 'ignore' });

      const srcRoot = path.join(tmp, 'package');
      for (const css of CSS_WEIGHTS) {
        if (!fs.existsSync(path.join(srcRoot, css))) throw new Error(`包内未找到 ${css}`);
      }

      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
      // css keeps relative url(files/…) refs — copy css at root, files/ as-is.
      // Normalize to font.css so the styles.css @import doesn't depend on the
      // package's internal naming.
      fs.writeFileSync(
        path.join(outDir, 'font.css'),
        CSS_WEIGHTS.map((c) => fs.readFileSync(path.join(srcRoot, c), 'utf8')).join('\n'),
      );
      const srcFiles = path.join(srcRoot, 'files');
      if (fs.existsSync(srcFiles)) {
        fs.mkdirSync(path.join(outDir, 'files'), { recursive: true });
        for (const f of fs.readdirSync(srcFiles)) {
          // 只收 font.css 引用的两个字重（跳过 light 和 lxgwwenkaimonolite-*）
          if (/^lxgwwenkailite-(regular|bold)-/.test(f))
            fs.copyFileSync(path.join(srcFiles, f), path.join(outDir, 'files', f));
        }
      }
      fs.writeFileSync(
        path.join(outDir, 'package.json'),
        JSON.stringify({ fetched: PKG, version: meta.version, css: CSS_WEIGHTS }, null, 2) + '\n',
      );
      const filesDir = path.join(outDir, 'files');
      const count = fs.existsSync(filesDir) ? fs.readdirSync(filesDir).length : 0;
      console.log(`  → ${outDir}（font.css: ${CSS_WEIGHTS.join(' + ')}，files/ ${count} 个分片, v${meta.version}）`);
      fs.rmSync(tmp, { recursive: true, force: true });
      ok = true;
      break;
    } catch (e) {
      lastErr = e;
      console.error(`  失败: ${e}`);
    }
  }
  if (!ok) {
    console.error(`\n字体下载失败（最后一个错误: ${lastErr}）。检查网络后重试，或手动放置到 ${outDir}`);
    process.exit(1);
  }
  console.log('\n内置手写字体资产就绪。');
}
await main();
