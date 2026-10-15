//! One-shot asset fetcher: downloads the bundled local embedding model
//! (Xenova/bge-small-zh-v1.5, ONNX q8) into packages/server/assets/models/.
//! Idempotent — existing complete files are kept. Run once at setup; the
//! artifacts are committed so builds never need network.
//!
//!   node scripts/fetch-embed-model.mjs [--refresh]
//!
//! --refresh re-downloads even when files already exist.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'Xenova/bge-small-zh-v1.5';
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
];
// hf-mirror first (reachable from CN networks); huggingface.co as fallback.
const MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co'];

const refresh = process.argv.includes('--refresh');
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'models', 'bge-small-zh-v1.5');

for (const file of FILES) {
  const dest = path.join(outDir, file);
  if (!refresh && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`已有 ${file}（${(fs.statSync(dest).size / 1e6).toFixed(1)}MB），跳过`);
    continue;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let ok = false;
  let lastErr = null;
  for (const mirror of MIRRORS) {
    const url = `${mirror}/${REPO}/resolve/main/${file}`;
    try {
      console.log(`下载 ${url}`);
      const resp = await fetch(url, { redirect: 'follow' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 100) throw new Error(`响应过小（${buf.length}B）— 可能是错误页`);
      fs.writeFileSync(dest, buf);
      console.log(`  → ${dest}（${(buf.length / 1e6).toFixed(1)}MB）`);
      ok = true;
      break;
    } catch (e) {
      lastErr = e;
      console.error(`  失败: ${e}`);
    }
  }
  if (!ok) {
    console.error(`\n${file} 下载失败（最后一个错误: ${lastErr}）。检查网络后重试，或手动放置文件到 ${outDir}`);
    process.exit(1);
  }
}
console.log('\n内置 embedding 模型资产就绪。');
