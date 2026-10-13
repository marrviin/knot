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

/** POST /projects（注册项目；name 缺省取 projectId 最后一段） */
export const RegisterProjectBody = Type.Object({
  projectId: Type.String(),
  name: Type.Optional(Type.String()),
});

/** GET /projects/:projectId/count?agent= */
export const CountQuery = Type.Object({ agent: Type.Optional(Type.String()) });

// ---------------------------------------------------------------------------
// Response schemas — consumed by @fastify/swagger into openapi.json; hey-api
// turns them into the renderer client's types. Request schemas above are ajv
// inputs; these are documentation/type sources only (Fastify still serializes
// by them, so optional fields must stay Optional, not nullable).
// ---------------------------------------------------------------------------

/** 单条记忆（GET /projects/:projectId/facts、各写路径的 facts 字段） */
export const FactSchema = Type.Object({
  id: Type.String(),
  memory: Type.String(),
  metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** Unix ms；created 早于 meta store 的事实为 null（UI 显示 "-"）。 */
  createdAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  updatedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});

export const FactsResponse = Type.Object({ facts: Type.Array(FactSchema) });

export const IngestReportSchema = Type.Object({
  added: Type.Number(),
  updated: Type.Number(),
  deleted: Type.Number(),
  notice: Type.Optional(Type.String()),
});

export const IngestResponse = Type.Object({
  report: IngestReportSchema,
  facts: Type.Array(FactSchema),
});

export const OkResponse = Type.Object({ ok: Type.Boolean() });

export const CountResponse = Type.Object({ count: Type.Number() });

/** POST /search 命中（含展示卡片所需的元数据）。 */
export const SemanticHitSchema = Type.Object({
  id: Type.String(),
  memory: Type.String(),
  score: Type.Number(),
  agent: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  updatedAt: Type.Optional(Type.Number()),
});

export const SearchResponse = Type.Object({ hits: Type.Array(SemanticHitSchema) });

export const HealthResponse = Type.Object({
  ok: Type.Boolean(),
  ready: Type.Boolean(),
  embedSignature: Type.Optional(Type.String()),
  embedModel: Type.Optional(Type.String()),
  notice: Type.Optional(Type.String()),
});

/** GET /projects 条目 */
export const ProjectInfoSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  factCount: Type.Number(),
  lastUpdated: Type.Union([Type.Number(), Type.Null()]),
});

export const ProjectsResponse = Type.Object({ projects: Type.Array(ProjectInfoSchema) });
