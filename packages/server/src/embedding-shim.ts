//! Embedding compatibility shim: translates mem0's OpenAI-format /embeddings
//! requests into MiniMax's native format (texts + type=db/query).
//! Empirical basis: MiniMax's /v1/embeddings rejects OpenAI's `input` field
//! (it requires `texts`), and responds with {vectors} instead of {data[].embedding}.
//!
//! The upstream has an RPM limit (status_code 1002); embedding items one by one
//! during bulk ingestion trips it easily, so upstream calls are serialized with
//! throttling + rate-limit retries.

import http from 'node:http';
import type * as httpy from 'node:http';

export interface ShimHandle {
  server: httpy.Server;
  port: number;
  close(): void;
}

const MIN_UPSTREAM_INTERVAL_MS = 1100; // serial throttle to stay under MiniMax's RPM limit
const RATE_LIMIT_CODES = new Set([1002]);
const MAX_RETRIES = 5;
const UPSTREAM_TIMEOUT_MS = 60_000; // a TCP stall must fail the request, not stall the serialized queue forever

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startEmbeddingShim(
  apiKey: string,
  upstreamBase: string,
  /** MiniMax embedding model to request upstream — always supplied from settings */
  embedModel: string,
): Promise<ShimHandle> {
  // Serialize upstream calls: at most one in-flight request, with a minimum interval
  let queue: Promise<void> = Promise.resolve();
  let lastCallAt = 0;

  async function callUpstream(texts: string[], type: string): Promise<any> {
    const gate = queue.then(async () => {
      const wait = MIN_UPSTREAM_INTERVAL_MS - (Date.now() - lastCallAt);
      if (wait > 0) await sleep(wait);
      for (let attempt = 0; ; attempt++) {
        lastCallAt = Date.now();
        const resp = await fetch(`${upstreamBase.replace(/\/$/, '')}/embeddings`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: embedModel, texts, type }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        const data = (await resp.json()) as MiniMaxEmbedResponse;
        if (data.base_resp?.status_code === 0) return data;
        if (data.base_resp && RATE_LIMIT_CODES.has(data.base_resp.status_code) && attempt < MAX_RETRIES) {
          const backoff = 5000 * (attempt + 1);
          console.error(`[Knot Shim] 上游限流，${backoff / 1000}s 后重试（第 ${attempt + 1} 次）`);
          await sleep(backoff);
          continue;
        }
        console.error('[Knot Shim] embedding 上游错误:', data.base_resp);
        // Fail loudly: mem0's OpenAI embedder throws on non-2xx, surfacing the
        // failure (empty vectors would silently corrupt retrieval/ingestion).
        throw new Error(`embedding 上游错误: ${JSON.stringify(data.base_resp ?? data)}`);
      }
    });
    queue = gate.then(() => {}, () => {});
    return gate;
  }

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
      // Heuristic: single item = retrieval (query), multiple items = ingestion (db)
      const type = texts.length === 1 ? 'query' : 'db';
      const data = await callUpstream(texts, type);
      const vectors: number[][] = data.vectors;
      if (!Array.isArray(vectors)) throw new Error('上游返回缺少 vectors 字段');
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          object: 'list',
          data: vectors.map((embedding, i) => ({ object: 'embedding', index: i, embedding })),
          model: 'embo-01',
          usage: { prompt_tokens: data.total_tokens ?? 0, total_tokens: data.total_tokens ?? 0 },
        }),
      );
    } catch (e) {
      console.error('[Knot Shim] 转换失败:', e);
      // 502: an upstream failure (mem0 retries semantics); other errors (bad
      // request body etc.) would also land here, but 502 keeps the client retrying.
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

/** MiniMax /embeddings response — the shim's upstream wire shape (contrast with
 *  mem0's OpenAI {data[].embedding}; MiniMax answers {vectors} + base_resp status). */
interface MiniMaxEmbedResponse {
  vectors?: number[][];
  total_tokens?: number;
  base_resp?: { status_code: number; message?: string };
}
