//! Core wiring: the mem0-backed implementation bound to server config, plus the
//! CoreApi contract the routes consume (tests can stub it instead of the mem0
//! instance). Route modules reach it through the `core` instance decoration —
//! nothing outside this directory imports memory-core directly.

import type { FactItem, IngestReport, SemanticHit } from '@knot/shared';

import type { ServerConfig } from '../config';
import * as core from './memory-core';

export { shutdown } from './memory-core';

/** Operations the routes need; injectable so tests can stub the mem0 core. */
export interface CoreApi {
  ingest(
    projectId: string,
    raw: string,
    meta: { agent: string; type: string; source: string },
    preferExisting: Set<string>,
  ): Promise<{ report: IngestReport; facts: FactItem[] }>;
  addManualMemory(
    projectId: string,
    content: string,
  ): Promise<{ report: IngestReport; facts: FactItem[] }>;
  updateFact(memoryId: string, content: string): Promise<void>;
  removeFact(memoryId: string): Promise<void>;
  listFacts(projectId: string): Promise<FactItem[]>;
  semanticSearch(projectId: string, query: string, topK: number): Promise<SemanticHit[]>;
  countByAgent(projectId: string, agent: string): Promise<number>;
  shutdown(): void;
}

/** Bind the real mem0-backed core to the server config. */
export function realCore(cfg: ServerConfig): CoreApi {
  return {
    ingest: (projectId, raw, meta, preferExisting) =>
      core.ingest(cfg.llm, cfg.dataDir, projectId, raw, meta, preferExisting),
    addManualMemory: (projectId, content) =>
      core.addManualMemory(cfg.llm, cfg.dataDir, projectId, content),
    updateFact: (memoryId, content) => core.updateFact(cfg.llm, cfg.dataDir, memoryId, content),
    removeFact: (memoryId) => core.removeFact(cfg.llm, cfg.dataDir, memoryId),
    listFacts: (projectId) => core.listFacts(cfg.llm, cfg.dataDir, projectId),
    semanticSearch: (projectId, query, topK) =>
      core.semanticSearch(cfg.llm, cfg.dataDir, projectId, query, topK),
    countByAgent: (projectId, agent) => core.countByAgent(cfg.llm, cfg.dataDir, projectId, agent),
    shutdown: () => core.shutdown(),
  };
}
