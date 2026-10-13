import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import {
  CountQuery,
  CountResponse,
  FactUpdateBody,
  FactsResponse,
  IdParams,
  IngestResponse,
  ManualFactBody,
  OkResponse,
  ProjectIdParams,
} from '../schemas';

export default async function factRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Static<typeof ManualFactBody> }>(
    '/facts',
    { schema: { body: ManualFactBody, response: { 200: IngestResponse }, operationId: 'addFact' } },
    async (req) => {
      const projectId = req.body.projectId.trim();
      if (!projectId) throw app.httpErrors.badRequest('projectId 不能为空');
      const content = req.body.content.trim();
      if (!content) throw app.httpErrors.badRequest('记忆内容不能为空');
      return app.core.addManualMemory(projectId, content);
    },
  );

  app.put<{ Params: Static<typeof IdParams>; Body: Static<typeof FactUpdateBody> }>(
    '/facts/:id',
    { schema: { params: IdParams, body: FactUpdateBody, response: { 200: OkResponse }, operationId: 'updateFact' } },
    async (req) => {
      const content = req.body.content.trim();
      if (!content) throw app.httpErrors.badRequest('记忆内容不能为空');
      await app.core.updateFact(req.params.id, content);
      return { ok: true };
    },
  );

  app.delete<{ Params: Static<typeof IdParams> }>(
    '/facts/:id',
    { schema: { params: IdParams, response: { 200: OkResponse }, operationId: 'deleteFact' } },
    async (req) => {
      await app.core.removeFact(req.params.id);
      return { ok: true };
    },
  );

  app.get<{ Params: Static<typeof ProjectIdParams> }>(
    '/projects/:projectId/facts',
    { schema: { params: ProjectIdParams, response: { 200: FactsResponse }, operationId: 'listFacts' } },
    async (req) => {
      return { facts: await app.core.listFacts(req.params.projectId) };
    },
  );

  app.get<{ Params: Static<typeof ProjectIdParams>; Querystring: Static<typeof CountQuery> }>(
    '/projects/:projectId/count',
    { schema: { params: ProjectIdParams, querystring: CountQuery, response: { 200: CountResponse }, operationId: 'countFacts' } },
    async (req) => {
      const agent = (req.query.agent ?? '').trim();
      if (!agent) throw app.httpErrors.badRequest('agent 参数不能为空');
      return { count: await app.core.countByAgent(req.params.projectId, agent) };
    },
  );
}
