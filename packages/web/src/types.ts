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
  /** Display timestamps (unix ms) from the service's meta store — null for
   *  facts created before it existed (UI renders "-"). */
  createdAt: number | null;
  updatedAt: number | null;
}

/** One day's journal entry (<project>/.journal/logs/YYYY-MM-DD.md) — read-only
 *  for the UI; agents write the files directly. */
export interface JournalEntry {
  /** YYYY-MM-DD (from the file name) */
  date: string;
  content: string;
  /** File mtime, unix ms */
  mtime: number;
}

/** A project's days that have memory activity but no journal file yet
 *  (GET /journals/pending — the generate button's pre-check) */
export interface JournalPending {
  projectId: string;
  name: string;
  dates: string[];
}

/** Progress of the one-time existing-content import (journal://import-progress) */
export interface ImportProgress {  /** Project path ('' for a global notice, e.g. LLM not configured) */
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
