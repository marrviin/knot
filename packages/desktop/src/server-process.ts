//! Memory-server child-process lifecycle (local mode only).
//!
//! The mem0 core (+ vector store + embedding shim) runs as a standalone HTTP
//! service in `server/`; local mode spawns it as a child of the Electron main
//! process so the same code path serves local and remote deployments.
//!
//! - `ELECTRON_RUN_AS_NODE=1` + `process.execPath`: run the Electron binary as
//!   plain Node so better-sqlite3 keeps matching the Electron ABI (the existing
//!   rebuild:electron output) — a system Node would hit an ABI mismatch.
//! - Port: a free loopback port is picked per launch; an ephemeral bearer token
//!   is generated per launch so the loopback API is not open to other local
//!   processes.
//! - Crash handling is lazy by design: any API call routes through
//!   ensureMemory(), which respawns the child when it has died. Mid-flight
//!   requests fail with a clear error instead of hanging.

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { log } from './log';

/** LLM settings passed through to the child (server owns the extraction pipeline). */
export interface ChildLlmSettings {
  provider: 'minimax' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
  embedModel: string;
}

export interface ServerProcess {
  port: number;
  token: string;
  stop(): void;
}

let child: ChildProcess | null = null;
let currentPort = 0;
let currentToken = '';
let stopping = false;

/** Locate dist-server/index.cjs: dev runs from packages/desktop/dist-electron —
 *  up three levels to the repo root, then into packages/server/dist-server;
 *  packaged apps read from process.resourcesPath (electron-builder extraResources). */
function resolveServerEntry(): string | null {
  const candidates = [
    path.join(__dirname, '..', '..', 'server', 'dist-server', 'index.cjs'),
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'dist-server', 'index.cjs')] : []),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Packaged apps keep better-sqlite3 unpacked next to the asar — point NODE_PATH
 *  there so the CJS bundle (which keeps better-sqlite3 external) can resolve it.
 *  Dev needs nothing: dist-server sits under the repo root's node_modules. */
function unpackedNodeModules(): string | null {
  const candidate = process.resourcesPath
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : null;
  return candidate && fs.existsSync(candidate) ? candidate : null;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    // Listen on 0 to grab an ephemeral port, then hand it to the child. The tiny
    // close→spawn race is acceptable on loopback: the health poll retries anyway.
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitHealthy(port: number, token: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    if (stopping) throw new Error('应用正在退出，记忆服务启动已取消');
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) return;
      lastErr = `HTTP ${resp.status}`;
    } catch (e) {
      lastErr = String(e);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`本地记忆服务启动超时（${lastErr || '无响应'}）`);
}

/** Spawn (or reuse) the local memory-server child. Throws with a user-actionable
 *  message when the bundle is missing or the child never becomes healthy. */
export async function ensureServerProcess(opts: {
  userDataDir: string;
  llm: ChildLlmSettings;
}): Promise<ServerProcess> {
  if (child && child.exitCode === null && currentPort) {
    return { port: currentPort, token: currentToken, stop: stopServer };
  }
  const entry = resolveServerEntry();
  if (!entry) {
    throw new Error('未找到记忆服务 bundle（dist-server/index.cjs）— 请先运行 pnpm build:server');
  }
  const port = await findFreePort();
  const token = crypto.randomBytes(24).toString('hex');
  stopping = false;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    KNOT_HOST: '127.0.0.1',
    KNOT_PORT: String(port),
    KNOT_TOKEN: token,
    KNOT_DATA_DIR: path.join(opts.userDataDir, 'mem0'),
    KNOT_LLM_PROVIDER: opts.llm.provider,
    KNOT_LLM_BASE_URL: opts.llm.baseUrl,
    KNOT_LLM_API_KEY: opts.llm.apiKey,
    KNOT_LLM_MODEL: opts.llm.model,
    KNOT_LLM_EMBED_MODEL: opts.llm.embedModel,
  };
  const nm = unpackedNodeModules();
  if (nm) env.NODE_PATH = nm;
  const c = spawn(process.execPath, [entry], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child = c;
  currentPort = port;
  currentToken = token;
  c.on('exit', (code, signal) => {
    if (child !== c) return;
    child = null;
    currentPort = 0;
    currentToken = '';
    // Lazy respawn: the next ensureMemory() call starts a fresh child. Log only —
    // a crash mid-ingest surfaces through that request's error path.
    log(`记忆服务子进程退出 code=${code ?? '-'} signal=${signal ?? '-'}（下次调用时自动重启）`);
  });
  try {
    await waitHealthy(port, token, 20_000);
  } catch (e) {
    // Startup failed: kill the child so it can't linger, then surface the cause.
    stopping = true;
    c.kill();
    child = null;
    currentPort = 0;
    currentToken = '';
    stopping = false;
    throw e;
  }
  log(`记忆服务子进程已就绪: http://127.0.0.1:${port}`);
  return { port, token, stop: stopServer };
}

export function stopServer(): void {
  const c = child;
  child = null;
  currentPort = 0;
  currentToken = '';
  if (!c || c.exitCode !== null) return;
  stopping = true;
  c.kill();
  // Grace period: SIGTERM then SIGKILL if it ignores shutdown (mem0 teardown can
  // take a moment on the sqlite handles).
  const t = setTimeout(() => c.kill('SIGKILL'), 3000);
  c.once('exit', () => clearTimeout(t));
  stopping = false;
}

/** Whether a live child process exists (used by isReady / diagnostics). */
export function isServerRunning(): boolean {
  return !!child && child.exitCode === null;
}
