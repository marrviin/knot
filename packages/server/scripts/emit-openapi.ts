//! Snapshot the Fastify-generated OpenAPI document to openapi.json. This is the
//! committed hey-api generation input — the renderer's generated client types
//! track this file, so keep it in sync whenever route schemas change.

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { realCore } from '../src/core';

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.resolve(here, '../openapi.json');

  // Throwaway dataDir — schema emission never touches the store, and the real
  // config would require an LLM env just to build the document.
  const cfg = loadConfig({ KNOT_DATA_DIR: path.join(os.tmpdir(), 'knot-emit-openapi') });
  const app = buildApp(cfg, realCore(cfg));
  await app.ready();
  const doc = app.swagger();
  await app.close();

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`openapi.json emitted → ${outPath} (${Object.keys(doc.paths ?? {}).length} paths)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
