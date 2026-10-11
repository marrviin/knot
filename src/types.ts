export interface Project {
  path: string;
  name: string;
  factCount: number;
  lastUpdated: number | null;
}

export interface Fact {
  /** mem0 memory uuid */
  id: string;
  projectId: string;
  content: string;
  /** Agent that produced the memory: claude-code / joycode / myagent / user */
  agent: string;
  /** Memory carrier type: local-memory / manual */
  type: string;
  /** Concrete source file path */
  source: string;
  createdAt: number;
  updatedAt: number;
}

/** Progress of the one-time existing-content import (knot://import-progress) */
export interface ImportProgress {
  /** Project path ('' for a global notice, e.g. LLM not configured) */
  project: string;
  ruleId: string;
  phase: 'start' | 'file' | 'done';
  /** 'file': 1-based index; 'start': 0; 'done': total */
  current: number;
  total: number;
  /** 'file' phase only: the file just ingested */
  file?: string;
  /** 'done' phase only: cumulative report for this rule × project */
  report?: { added: number; updated: number; deleted: number; notice?: string };
  /** 'done' phase only: failure notice (import will retry on the next trigger) */
  notice?: string;
}
