//! Project registry routes — the display layer's project list and delete, so
//! the renderer (desktop or web) can render projects straight from the service.
//! Facts live per project in mem0; the registry itself is the server-side meta
//! store (store.ts).

import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { OkResponse, ProjectIdParams, ProjectInfoSchema, ProjectsResponse, RegisterProjectBody } from '../schemas';
import { GLOBAL_PROJECT } from '../store';

export default async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/projects',
    { schema: { response: { 200: ProjectsResponse }, operationId: 'listProjects' } },
    async () => ({ projects: await app.core.listProjects() }),
  );

  app.post<{ Body: Static<typeof RegisterProjectBody> }>(
    '/projects',
    {
      schema: { body: RegisterProjectBody, response: { 200: ProjectInfoSchema }, operationId: 'registerProject' },
    },
    async (req) => {
      const projectId = req.body.projectId.trim();
      if (!projectId) throw app.httpErrors.badRequest('projectId 不能为空');
      return app.core.registerProject(projectId, req.body.name);
    },
  );

  app.delete<{ Params: Static<typeof ProjectIdParams> }>(
    '/projects/:projectId',
    {
      schema: { params: ProjectIdParams, response: { 200: OkResponse }, operationId: 'removeProject' },
    },
    async (req) => {
      // Reserved virtual project (agent-level global memories) — never deletable.
      if (req.params.projectId === GLOBAL_PROJECT)
        throw app.httpErrors.badRequest('全局记忆项目不可删除');
      await app.core.removeProject(req.params.projectId);
      return { ok: true };
    },
  );
}
