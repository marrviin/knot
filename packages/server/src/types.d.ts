//! Fastify instance decorations: route plugins read the server config and the
//! mem0 core through `app.cfg` / `app.core` instead of closures, so every route
//! group is a standalone plugin that registers in any scope.

import type { ServerConfig } from './config';
import type { CoreApi } from './core';

declare module 'fastify' {
  interface FastifyInstance {
    cfg: ServerConfig;
    core: CoreApi;
  }
}
