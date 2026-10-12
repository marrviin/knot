//! TypeBox request schemas — Fastify compiles them with ajv, so structural
//! garbage answers 400 before any handler runs. Field-level rules (trim + 空
//! 值检查) stay in the handlers on purpose: ajv's messages are English, and
//! those checks keep the Chinese error strings the desktop client surfaces.

import { Type } from '@sinclair/typebox';

/** POST /ingest */
export const IngestBody = Type.Object({
  projectId: Type.String(),
  raw: Type.String(),
  meta: Type.Optional(
    Type.Object({
      agent: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
      source: Type.Optional(Type.String()),
    }),
  ),
  preferExisting: Type.Optional(Type.Array(Type.String())),
});

/** POST /facts */
export const ManualFactBody = Type.Object({
  projectId: Type.String(),
  content: Type.String(),
});

/** PUT /facts/:id */
export const FactUpdateBody = Type.Object({
  content: Type.String(),
});

/** POST /search */
export const SearchBody = Type.Object({
  projectId: Type.String(),
  query: Type.String(),
  topK: Type.Optional(Type.Number()),
});

/** :id params（PUT/DELETE /facts/:id） */
export const IdParams = Type.Object({ id: Type.String() });

/** :projectId params（GET /projects/:projectId/…） */
export const ProjectIdParams = Type.Object({ projectId: Type.String() });

/** GET /projects/:projectId/count?agent= */
export const CountQuery = Type.Object({ agent: Type.Optional(Type.String()) });
