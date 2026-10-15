//! TypeBox request schemas — Fastify compiles them with ajv, so structural
//! garbage answers 400 before any handler runs. Field-level rules (trim + 空
//! 值检查) stay in the handlers on purpose: ajv's messages are English, and
//! those checks keep the Chinese error strings the desktop client surfaces.

import { Type } from '@sinclair/typebox';
import { SBTI_TYPES } from '@journal/shared';

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
  /** Source file's mtime (unix ms) — facts display the file's last-updated
   *  time, not the ingest moment; absent → stamped with now (manual writes). */
  sourceMtime: Type.Optional(Type.Number()),
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

/** GET /projects/:projectId/journals 条目（.journal/logs/YYYY-MM-DD.md，一天一文件） */
export const JournalSchema = Type.Object({
  date: Type.String(),
  content: Type.String(),
  mtime: Type.Number(),
});

export const JournalsResponse = Type.Object({ journals: Type.Array(JournalSchema) });

/** GET /journals/pending — days that have memory activity but no journal file */
export const JournalPendingSchema = Type.Object({
  projectId: Type.String(),
  name: Type.String(),
  dates: Type.Array(Type.String()),
});

export const JournalsPendingResponse = Type.Object({
  pending: Type.Array(JournalPendingSchema),
});

/** GET /journals/pending?projectId= / POST /journals/generate {projectId?} —
 *  absent → all registered projects (hourly tick semantics) */
export const JournalScopeQuery = Type.Object({
  projectId: Type.Optional(Type.String()),
});

export const JournalScopeBody = Type.Object({
  projectId: Type.Optional(Type.String()),
});

/** POST /journals/regenerate — debug: one project, required（误删全部项目不可接受） */
export const JournalProjectBody = Type.Object({
  projectId: Type.String(),
});

/** GET/PUT /settings/personalization — 个性化设置（日记作者对用户的称呼 + 搭档性格）。
 *  personality 的合法值是 SBTI 27 型的 id 或 ''（未设置），ajv 直接把非法值挡成 400。 */
export const PersonalityIdSchema = Type.Union([
  Type.Literal(''),
  ...SBTI_TYPES.map((t) => Type.Literal(t.id)),
]);

export const PersonalizationBody = Type.Object({
  displayName: Type.String(),
  personality: PersonalityIdSchema,
});

export const PersonalizationResponse = Type.Object({
  displayName: Type.String(),
  personality: PersonalityIdSchema,
});
