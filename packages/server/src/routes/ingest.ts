import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { IngestBody } from '../schemas';

export default async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Static<typeof IngestBody> }>(
    '/ingest',
    { schema: { body: IngestBody } },
    async (req) => {
      const b = req.body;
      const projectId = b.projectId.trim();
      if (!projectId) throw app.httpErrors.badRequest('projectId 不能为空');
      const raw = b.raw.trim();
      if (!raw) throw app.httpErrors.badRequest('记忆内容不能为空');
      const meta = {
        agent: b.meta?.agent ?? 'unknown',
        type: b.meta?.type ?? 'local-memory',
        source: b.meta?.source ?? '',
      };
      return app.core.ingest(projectId, raw, meta, new Set(b.preferExisting ?? []));
    },
  );
}
