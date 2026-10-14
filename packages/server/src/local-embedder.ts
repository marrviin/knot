//! Local embedding server: runs the bundled bge-small-zh-v1.5 ONNX model
//! (via @huggingface/transformers, onnxruntime-node backend) inside the server
//! process and answers mem0's OpenAI-format /embeddings requests — the same
//! wire format the MiniMax shim serves, so mem0 keeps a plain openai embedder
//! pointed at 127.0.0.1 and never learns the vectors are computed locally.
//!
//! bge-small-zh-v1.5 usage: symmetric similarity needs no input prefix (the
//! official retrieval instruction applies to short-query → long-doc search,
//! which Knot's fact recall is not) — texts are embedded as-is.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/** Handle of the local embedding side-server (one per mem0 instance lifetime). */
export interface ShimHandle {
  server: http.Server;
  port: number;
  close(): void;
}

export const LOCAL_EMBED_DIMS = 512;

/** Per-request batch cap. ORT's CPU arena aborts (SIGTRAP) when a single large
 *  batch's intermediate tensors (batch×12×512² fp32 ≈ 400MB at 33) force repeated
 *  arena extensions; small fixed-size chunks keep allocations reusable — verified
 *  against 240 consecutive embeds with growing fact sets where the unchunked
 *  path died at call #6. */
const MAX_BATCH = 8;
/** Char budget per input: ~512 tokens for CJK-heavy text (bge tokenizer), so the
 *  tokenizer's model_max_length=512 truncation is never the only line of defense
 *  against pathological inputs. */
const MAX_CHARS = 1200;

/** Locate the bundled model directory. dist-server/models covers the esbuild
 *  bundle (dev) and the packaged resources copy; ../assets/models covers
 *  `tsx src/index.ts` where __dirname is src/. */
export function resolveLocalModelDir(): string | null {
  const candidates = [
    path.join(__dirname, 'models', 'bge-small-zh-v1.5'),
    path.join(__dirname, '..', 'assets', 'models', 'bge-small-zh-v1.5'),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, 'config.json'))) ?? null;
}

type Extractor = (
  texts: string[],
  opts: { pooling: 'cls'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/** Start the local embedder: loads the model (a few seconds, once per server
 *  process) and serves /embeddings until close(). Requests are serialized —
 *  bounding memory and keeping latency predictable during bulk ingestion. */
export async function startLocalEmbedder(modelDir: string): Promise<ShimHandle> {
  const { pipeline } = await import('@huggingface/transformers');
  // cls pooling — bge-small-zh uses the [CLS] embedding (normalized) as the
  // sentence representation, unlike e5's mean pooling.
  const extractor = (await pipeline('feature-extraction', modelDir, { dtype: 'q8' })) as unknown as Extractor;
  console.log(`[Knot local-embedder] 模型已加载: ${modelDir}`);

  let queue: Promise<void> = Promise.resolve();
  const embed = async (texts: string[]): Promise<number[][]> => {
    const capped = texts.map((t) => (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t));
    const vectors: number[][] = [];
    // Chunked, serialized batches: bounds both transient arena memory and shape churn.
    for (let i = 0; i < capped.length; i += MAX_BATCH) {
      const slice = capped.slice(i, i + MAX_BATCH);
      const gate = queue.then(async () => {
        const out = await extractor(slice, { pooling: 'cls', normalize: true });
        const rows = out.tolist();
        if (rows.length !== slice.length || rows.some((v) => v.length !== LOCAL_EMBED_DIMS)) {
          throw new Error(`本地 embedding 输出异常: ${rows.length} 条 / ${rows[0]?.length ?? 0} 维`);
        }
        return rows;
      });
      queue = gate.then(() => {}, () => {});
      vectors.push(...(await gate));
    }
    return vectors;
  };

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/embeddings')) {
      res.writeHead(404).end('not found');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { input } = JSON.parse(body);
      const texts: string[] = Array.isArray(input) ? input : [input];
      if (!texts.length || texts.some((t) => typeof t !== 'string' || !t.trim())) {
        throw new Error('input 必须是非空字符串数组');
      }
      const vectors = await embed(texts);
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          object: 'list',
          data: vectors.map((embedding, i) => ({ object: 'embedding', index: i, embedding })),
          model: 'bge-small-zh-v1.5',
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }),
      );
    } catch (e) {
      console.error('[Knot local-embedder] embedding 失败:', e);
      // 502 keeps the same failure semantics as the MiniMax shim (mem0's openai
      // embedder retries on it); empty vectors would silently corrupt retrieval.
      res.writeHead(502).end(JSON.stringify({ error: { message: String(e) } }));
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, close: () => server.close() });
    });
  });
}
