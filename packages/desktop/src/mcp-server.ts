//! MCP server: serves each project's shared memories (keyword search over the
//! facts mirror store) via JSON-RPC 2.0.
//! - stdio mode (`knot --mcp-server`): headless fallback spawned manually, line-delimited JSON-RPC over stdin/stdout.
//! - HTTP mode (default GUI): the running app hosts `http://127.0.0.1:<port>/mcp`
//!   (stateless Streamable-HTTP-style: one JSON response per POST, no session id),
//!   so Claude Code connects via a static `{"type":"http"}` entry instead of
//!   spawning an Electron subprocess.

import * as http from 'node:http';
import * as readline from 'node:readline';
import { app } from 'electron';

import * as store from './store';
import * as mem0 from './mem0';

/** Default loopback port for the HTTP MCP endpoint. The injected Claude Code
 *  config hardcodes this URL, so a conflict must not silently shift ports. */
export const KNOT_MCP_PORT = 27183;

export interface McpHttpHandle {
  server: http.Server;
  port: number;
  url: string;
  close(): void;
}

/** Start the loopback HTTP MCP server. Resolves even when the port is taken
 *  (another Knot instance is presumed to be serving there) — `handle` is then
 *  null, which callers surface via log instead of failing the GUI startup. */
/** Caller identity embedded in the URL path (`/mcp/<agent>`): the HTTP endpoint is
 *  stateless (one JSON response per POST, no session), so per-connection clientInfo
 *  can't be remembered — the path segment travels on every request instead. inject
 *  writes one path per agent; unknown segments are harmless (they only filter that
 *  agent's own facts out of "others" mode). */
export function parseMcpPath(url: string | undefined): { agent?: string } | null {
  const m = /^\/mcp(?:\/([^/?]+))?(?:\?.*)?$/.exec(url ?? '');
  if (!m) return null;
  const agent = m[1] ? decodeURIComponent(m[1]).trim() : '';
  return { agent: agent || undefined };
}

export function startMcpHttpServer(port = mcpPort()): Promise<McpHttpHandle | null> {
  const server = http.createServer(async (req, res) => {
    const parsed = parseMcpPath(req.url);
    if (req.method !== 'POST' || !parsed) {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let msg: any;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '解析 JSON 失败' } }));
      return;
    }
    // Notifications need no reply; 202 Accepted keeps Streamable-HTTP clients happy.
    if (typeof msg?.method === 'string' && msg.method.startsWith('notifications/')) {
      res.writeHead(202).end();
      return;
    }
    const result = await handleJsonRpc(msg, parsed.agent);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, ...(result) }));
  });

  return new Promise((resolve) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`[Knot] MCP 端口 ${port} 已被占用(可能是另一个 Knot 实例正在服务),本次不重复启动`);
        resolve(null);
      } else {
        console.error('[Knot] MCP HTTP 服务启动失败:', e);
        resolve(null);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}/mcp`,
        close: () => server.close(),
      });
    });
  });
}

export function mcpPort(): number {
  const env = Number(process.env.KNOT_MCP_PORT);
  return Number.isInteger(env) && env > 0 ? env : KNOT_MCP_PORT;
}

export function runMcpServer(): void {

  const rl = readline.createInterface({ input: process.stdin });
  const write = (obj: unknown) => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  };

  // Serialize replies: the semantic fallback makes handling async, and responses
  // for earlier lines must not land after responses for later ones.
  let queue: Promise<void> = Promise.resolve();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore invalid lines
    }
    if (typeof msg.method === 'string' && msg.method.startsWith('notifications/')) return; // notifications need no reply

    queue = queue.then(async () => {
      // stdio mode: one agent per spawned process — KNOT_AGENT is its identity
      // (set by whoever configures the headless spawn; unset = unknown caller).
      write({ jsonrpc: '2.0', id: msg.id ?? null, ...(await handleJsonRpc(msg, process.env.KNOT_AGENT || undefined)) });
    });
  });

  rl.on('close', () => process.exit(0));
}

/** Host process context (userData dir) — required for the mem0 semantic fallback;
 *  empty in tests / unset contexts, which disables the fallback. */
let mcpUserDataDir = '';

export function setMcpContext(userDataDir: string): void {
  mcpUserDataDir = userDataDir;
}

/** Shared JSON-RPC dispatch: returns `{ result }` or `{ error: { code, message } }`.
 *  callerAgent: the calling agent's identity (HTTP path segment / stdio env) —
 *  drives the "others-first" recall filter; undefined = unknown caller. */
export async function handleJsonRpc(
  msg: any,
  callerAgent?: string,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const method: string = msg?.method ?? '';
  let result: unknown;
  try {
    switch (method) {
      case 'initialize':
        result = {
          // Echo the client's requested protocol version when known, else our floor.
          protocolVersion:
            typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'knot', version: app.getVersion() },
          instructions:
            'Knot is the cross-session shared memory for this project: previous agents distilled facts ' +
            '(decisions, pitfalls, conventions, env quirks) that future tasks must not rediscover the hard way. ' +
            'RULE: at the start of ANY task — before planning or writing code — call recall_memories first. ' +
            'Pass query for targeted recall (keywords or a natural-language question); omit query to fetch the latest memories. ' +
            'By default recall returns memories left by OTHER agents only — an empty result means they left ' +
            'nothing here, not that the project has no memories (pass mode:"all" to include your own). ' +
            'Only if recall_memories cannot resolve the project, call list_projects to find the right project_id. ' +
            'Do not skip recall just because the task looks small: prior facts often cover exactly that area.',
        };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = toolsManifest();
        break;
      case 'tools/call':
        result = await handleToolCall(msg, callerAgent);
        break;
      default:
        return { error: { code: -32601, message: `方法未实现: ${method}` } };
    }
    return { result };
  } catch (e) {
    return { error: { code: -32603, message: String(e) } };
  }
}

function toolsManifest() {
  return {
    tools: [
      {
        name: 'recall_memories',
        description:
          'Recall shared memories that previous agents left for this project (Knot facts: ' +
          'decisions, pitfalls, conventions, environment quirks). USE WHEN starting any task in the ' +
          'project — call this BEFORE planning or implementing, so you build on what is already known ' +
          'instead of rediscovering it. Also USE WHEN the task touches an area that was likely worked ' +
          'on before. Pass query for targeted recall (keywords or natural-language questions; the ' +
          'server fuses BM25 keyword and semantic vector retrieval); omit query to fetch the most ' +
          'recent memories. By default only memories left by OTHER agents are returned — an empty ' +
          'result means they left nothing here, not that the project has no memories (pass ' +
          'mode:"all" to include your own).',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Optional: search keywords or a natural-language question. Omit to fetch the most recent memories. Separate multiple keywords with spaces.',
            },
            project_id: {
              type: 'string',
              description:
                'Optional: the project to recall from — its absolute path (or a path to any subdirectory of it), or its registered name. Defaults to the current working directory.',
            },
            mode: {
              type: 'string',
              enum: ['others', 'all', 'self'],
              description:
                'Optional: whose memories to recall. "others" (default) = only other agents\' memories (an empty result honestly means they left nothing; your own are NOT included as fallback). "all" = everyone\'s, including your own. "self" = only your own. Ignored when the caller identity is unknown.',
            },
            agent: {
              type: 'string',
              description:
                'Optional: your agent id (e.g. "claude-code", "codex", "joycode"). Only needed when the server cannot identify you (plain /mcp URL or stdio without KNOT_AGENT); with it, the default "others" mode can exclude your own memories.',
            },
          },
        },
      },
      {
        name: 'list_projects',
        description:
          'List all projects registered in Knot with their memory counts. Call this when ' +
          'recall_memories cannot resolve the current project, to find the right project_id.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
}

function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// (exported for tests)
export async function handleToolCall(msg: any, callerAgent?: string) {
  const name: string = msg.params?.name ?? '';
  const args = msg.params?.arguments ?? {};

  let text: string;
  switch (name) {
    case 'recall_memories':
      text = await fetchKnots(args, callerAgent);
      break;
    case 'list_projects':
      text = listProjectsText();
      break;
    default:
      return toolError(`未知工具: ${name}`);
  }
  return { content: [{ type: 'text', text }] };
}

/** HTTP 模式下,请求来自本机任意 cwd 的客户端 — project_id 解析完全靠显式参数。
 *  stdio 模式下 cwd 是 Claude Code 的启动目录,作为默认值仍有意义。 */
function currentProjectId(): string {
  try {
    return process.cwd();
  } catch {
    return '';
  }
}

// (exported for tests)
// Vector hits below this cosine are noise: live evals against embo-01 showed
// truly relevant memories at 0.39–0.79 and coincidental ones at 0.20–0.36, so
// 0.4 sits just above the observed noise floor. Revisit when the embedder
// changes — score scales are model-specific.
const SEMANTIC_MIN_SCORE = 0.4;
// Absolute-score bonus folded into the fusion ranking: RRF only knows ranks,
// so without it a 0.79 vector hit loses to keyword rows that merely matched a
// shared character. 0.05 puts each 0.1 of cosine on par with ~3 RRF ranks.
const SEMANTIC_WEIGHT = 0.05;

/** One fused retrieval hit, shared by the MCP tool and the GUI search panel. */
export interface HybridHit {
  id: string;
  content: string;
  keyword: boolean;
  /** Negated FTS5 bm25 (higher = better); present only on keyword hits. */
  kScore?: number;
  /** Embedding cosine (0-1); present only when the semantic path contributed. */
  semanticScore?: number;
  /** Mirror metadata, for the GUI result cards. */
  agent?: string;
  type?: string;
  source?: string;
  updatedAt?: number;
}

/** Hybrid retrieval core shared by the MCP recall_memories tool and the GUI
 *  search: BM25 over the mirror (local, always available) + mem0 vector search
 *  (only when mem0 is initialized in this host process), fused by RRF so a fact
 *  both paths surface outranks either single path. When mem0 is unconfigured this
 *  degrades to pure keyword search with identical semantics. Both consumers get
 *  identical results — same gates, same fusion. agentFilter narrows both paths
 *  BEFORE fusion (so an excluded caller's own hits can't eat top slots); the GUI
 *  passes no filter. */
export async function hybridSearch(
  projectId: string,
  query: string,
  agentFilter?: store.AgentFilter,
): Promise<HybridHit[]> {
  const bm25 = store.searchFacts(projectId, query, agentFilter);
  let semantic: mem0.SemanticHit[] = [];
  if (mcpUserDataDir && mem0.isReady()) {
    try {
      // Filtering shrinks the usable pool, so ask the vector store for a few
      // extra candidates to keep the post-filter hit count comparable.
      const topK = agentFilter ? 12 : 8;
      const hits = await mem0.semanticSearch(mcpUserDataDir, projectId, query, topK);
      const seen = new Set<string>();
      semantic = hits
        .filter((h) => h.score >= SEMANTIC_MIN_SCORE)
        // Same agent exclusion as the keyword path — by mirror metadata, before
        // fusion (an excluded hit here would otherwise take one of topK's slots).
        .filter((h) => agentPasses(h.agent, agentFilter))
        // The vector store can hold twin copies of a memory (mem0's extraction
        // re-ADD dedup is unreliable) — collapse them so one memory doesn't eat
        // two of the 8 slots and show up twice in the results.
        .filter((h) => {
          const key = store.normalize(h.memory);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    } catch (e) {
      console.error('[Knot MCP] 语义检索回落失败:', e);
    }
  }
  // search() isn't documented as score-sorted; RRF ranks below need it.
  semantic.sort((a, b) => b.score - a.score);
  if (bm25.length === 0 && semantic.length === 0) return [];

  // RRF fusion (k=60, the standard constant): reciprocal ranks summed per fact id.
  const K = 60;
  const merged = new Map<
    string,
    { text: string; score: number; keyword: boolean; kScore?: number; semantic?: number }
  >();
  for (let i = 0; i < bm25.length; i++) {
    const f = bm25[i]!;
    merged.set(f.id, {
      text: f.content,
      score: 1 / (K + i + 1),
      keyword: true,
      kScore: f.kScore,
    });
  }
  for (let i = 0; i < semantic.length; i++) {
    const h = semantic[i]!;
    // RRF rank term plus an absolute-score bonus: rank alone ignores how
    // relevant a vector hit actually is (see SEMANTIC_WEIGHT above).
    const term = 1 / (K + i + 1) + h.score * SEMANTIC_WEIGHT;
    const e = merged.get(h.id);
    if (e) {
      e.score += term;
      e.semantic = h.score;
    } else {
      merged.set(h.id, { text: h.memory, score: term, keyword: false, semantic: h.score });
    }
  }
  const mirror = new Map(store.listFacts(projectId).map((f) => [f.id, f]));
  const ranked = [...merged.entries()]
    .sort(([, a], [, b]) => b.score - a.score)
    .map(([id, m]) => {
      const meta = mirror.get(id);
      return {
        id,
        content: m.text,
        keyword: m.keyword,
        kScore: m.kScore,
        semanticScore: m.semantic,
        agent: meta?.agent,
        type: meta?.type,
        source: meta?.source,
        updatedAt: meta?.updatedAt,
      } satisfies HybridHit;
    });
  return ranked;
}

function kTag(k: number | undefined): string {
  return `关键词 ${k != null ? k.toFixed(1) : '?'}`;
}

/** Mirror metadata may be missing (agent unknown) — that's not the caller's own,
 *  so it passes the exclusion and fails the self-only filter. */
function agentPasses(hitAgent: string | undefined, filter?: store.AgentFilter): boolean {
  if (!filter) return true;
  if (filter.onlyAgent) return hitAgent === filter.onlyAgent;
  if (filter.excludeAgent) return hitAgent !== filter.excludeAgent;
  return true;
}

export async function fetchKnots(args: any, callerAgent?: string): Promise<string> {
  const requested: string = args.project_id ?? currentProjectId();
  const query: string | undefined = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined;

  // Caller identity: HTTP path segment / stdio env first (config-owned, reliable),
  // then the tool argument (model self-declaration, best-effort fallback).
  const selfAgent =
    (typeof callerAgent === 'string' && callerAgent.trim()) ||
    (typeof args.agent === 'string' && args.agent.trim()) ||
    undefined;
  const requestedMode = args.mode === 'all' || args.mode === 'self' ? args.mode : 'others';
  // others + unknown caller: excluding is impossible, so degrade to the pre-mode
  // behavior (return everything) instead of silently returning nothing.
  const mode = requestedMode === 'others' && !selfAgent ? 'all' : requestedMode;
  const agentFilter: store.AgentFilter | undefined =
    mode === 'all' || !selfAgent
      ? undefined
      : mode === 'self'
        ? { onlyAgent: selfAgent }
        : { excludeAgent: selfAgent };

  const resolved = store.resolveProject(requested);
  if (!resolved) {
    return `【Knot 中央共享脑提示】未能定位与「${requested}」对应的项目（按绝对路径或项目名匹配）。` +
      `请调用 list_projects 查看已登记项目；若当前项目未登记，需先在 Knot 中接管该项目目录。`;
  }

  if (!query) {
    // No query = documented fetch-latest mode; pass through untouched (no fusion).
    const latest = store.searchFacts(resolved, undefined, agentFilter);
    if (latest.length === 0) {
      if (mode === 'others' && selfAgent) {
        const own = store.factCountByAgent(resolved, selfAgent);
        return `【Knot 中央共享脑提示】项目「${resolved}」暂无其他 agent 沉淀的共享记忆` +
          (own > 0 ? `（你自己的 ${own} 条未计入；需要时传 mode:"all" 查看全部）。` : '。');
      }
      return `【Knot 中央共享脑提示】项目「${resolved}」暂无共享记忆沉淀。`;
    }
    const body = latest.map((f) => `- ${f.content}`).join('\n');
    return `【Knot 中央共享脑提示】项目「${resolved}」最近沉淀的共享记忆如下：\n${body}`;
  }

  let hits: HybridHit[];
  try {
    hits = await hybridSearch(resolved, query, agentFilter);
  } catch (e) {
    return `【Knot 中央共享脑提示】检索失败: ${e}`;
  }
  if (hits.length === 0) {
    if (mode === 'others' && selfAgent) {
      const own = store.factCountByAgent(resolved, selfAgent);
      return `【Knot 中央共享脑提示】项目「${resolved}」中检索「${query}」在其他 agent 的记忆中无命中` +
        (own > 0
          ? `（你自己的 ${own} 条记忆未计入检索；可传 mode:"all" 一并检索，或换用其他关键词重试）。`
          : `。可换用其他关键词重试，或调用 list_projects 确认项目。`);
    }
    return `【Knot 中央共享脑提示】项目「${resolved}」中检索「${query}」无命中。可换用其他关键词重试，` +
      `或调用 list_projects 确认项目。`;
  }

  // Keyword-only results (mem0 unconfigured or the semantic path was gated away)
  // label just the BM25 score; once semantic participates, both signals are shown.
  // Scores are raw per-path signals (BM25 negated so higher = better; cosine 0-1)
  // — the fused ordering score stays internal.
  const semanticUsed = hits.some((h) => h.semanticScore != null);
  const body = hits
    .map((h) => {
      const tag = h.keyword && h.semanticScore != null
        ? `${kTag(h.kScore)} + 语义 ${h.semanticScore.toFixed(2)}`
        : h.keyword
          ? kTag(h.kScore)
          : `语义 ${h.semanticScore!.toFixed(2)}`;
      return `- [${tag}] ${h.content}`;
    })
    .join('\n');
  if (!semanticUsed) {
    return `【Knot 中央共享脑提示】项目「${resolved}」检索到的历史接力资产如下：\n${body}`;
  }
  return `【Knot 中央共享脑提示】项目「${resolved}」中检索「${query}」的混合检索结果（关键词 + 语义检索向量召回，RRF 融合）如下：\n${body}`;
}

function listProjectsText(): string {
  const projects = store.listProjects();
  if (projects.length === 0) {
    return '【Knot 中央共享脑提示】暂无已登记项目。';
  }
  const body = projects
    .map((p) => `- ${p.name}（${p.factCount} 条记忆）: ${p.path}`)
    .join('\n');
  return `【Knot 中央共享脑提示】已登记项目：\n${body}`;
}
