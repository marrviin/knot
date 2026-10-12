//! Fastify app: the memory service API. Local mode (Electron child process) and
//! remote mode (user-deployed Docker) serve the exact same contract — the client
//! is a thin HTTP wrapper either way.
//!
//! Contract (JSON):
//! - GET    /health                     → {ok, ready, embedSignature?, embedModel?}
//! - POST   /ingest  {projectId, raw, meta{agent,type,source}, preferExisting?}
//!                                       → {report:{added,updated,deleted,notice?}, facts:[{id,memory,metadata}]}
//! - POST   /facts   {projectId, content}                                → 同 /ingest
//! - PUT    /facts/:id {content}                                         → {ok}
//! - DELETE /facts/:id                                                   → {ok}
//! - GET    /projects/:projectId/facts                                   → {facts}
//! - POST   /search  {projectId, query, topK?}                           → {hits:[{id,memory,score}]}
//! - GET    /projects/:projectId/count?agent=                            → {count}
//!
//! Auth: when KNOT_TOKEN is set, every route except /health requires
//! `Authorization: Bearer <token>` — enforced by the encapsulated plugin in
//! plugins/auth.ts; /health is registered outside that scope.
//!
//! Layout: app.ts only wires plugins — route groups live in routes/ (each an
//! encapsulated Fastify plugin reading config/core via the instance decorations
//! in types.d.ts), request schemas in schemas.ts (TypeBox → ajv 400s before any
//! handler runs), and the mem0 core behind the CoreApi contract in core/.

import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';

import type { ServerConfig } from './config';
import { realCore, type CoreApi } from './core';
import bearerAuth from './plugins/auth';
import healthRoutes from './routes/health';
import ingestRoutes from './routes/ingest';
import factRoutes from './routes/facts';
import searchRoutes from './routes/search';

export function buildApp(cfg: ServerConfig, coreApi: CoreApi = realCore(cfg)): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.KNOT_LOG_LEVEL ?? 'info' },
    // /ingest waits on LLM extraction (minutes on bulk imports) — disable the
    // default request timeout; per-operation timeouts live in the core.
    requestTimeout: 0,
  });

  app.decorate('cfg', cfg);
  app.decorate('core', coreApi);
  app.register(sensible);

  // /health answers without a token (the desktop parent polls it before marking
  // the child ready); everything else sits behind bearer auth when configured.
  app.register(healthRoutes);
  app.register(async function protectedRoutes(protectedApp) {
    if (cfg.token) protectedApp.register(bearerAuth, { token: cfg.token });
    protectedApp.register(ingestRoutes);
    protectedApp.register(factRoutes);
    protectedApp.register(searchRoutes);
  });

  return app;
}
