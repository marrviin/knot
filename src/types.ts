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
