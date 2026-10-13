import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { SearchBody, SearchResponse } from '../schemas';

export default async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Static<typeof SearchBody> }>(
    '/search',
    { schema: { body: SearchBody, response: { 200: SearchResponse }, operationId: 'searchMemories' } },
    async (req) => {
      const b = req.body;
      const projectId = b.projectId.trim();
      if (!projectId) throw app.httpErrors.badRequest('projectId 不能为空');
      const query = b.query.trim();
      if (!query) throw app.httpErrors.badRequest('检索词不能为空');
      const topK = b.topK !== undefined && b.topK > 0 ? b.topK : 8;
      return { hits: await app.core.semanticSearch(projectId, query, topK) };
    },
  );
}
