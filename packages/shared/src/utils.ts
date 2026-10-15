//! Small pure utilities shared by the desktop client and the memory server.
//! Ported verbatim from server/src/memory-core.ts (withTimeout was previously
//! duplicated in electron/mem0.ts too).

/** Reject when the wrapped promise exceeds ms — without this, one hung upstream
 *  request (TCP stall) would block the serialized ingestion queue forever. */
// (exported for tests)
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s）`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Pair up near-duplicate items by embedding cosine. Threshold 0.98 is calibrated
 *  against the bundled bge-small-zh-v1.5: byte-identical and tiny-append re-adds
 *  score 0.997+, while a file and its one-line index summary — semantically the
 *  closest "distinct" pair observed — top out at 0.9535 (the previous embo-01-era
 *  0.95 collapsed that pair and ate the full document). Items earlier in the list
 *  win: the caller puts the preferred canonical first. Returns dupId → canonicalId. */
// (exported for tests)
export function findNearDupIds(
  items: { id: string }[],
  vectors: Map<string, number[]>,
  threshold = 0.98,
): Map<string, string> {
  const dupOf = new Map<string, string>();
  const kept: string[] = []; // canonical candidates so far
  for (const { id } of items) {
    const v = vectors.get(id);
    if (!v) continue;
    const twin = kept.find((k) => cosine(v, vectors.get(k)!) >= threshold);
    if (twin) dupOf.set(id, twin);
    else kept.push(id);
  }
  return dupOf;
}

// ---------- Deterministic memory chunking ----------

/** Split one ingested file into embeddable chunks. One fact per file is fine for
 *  focused notes, but long files dilute the single vector (multi-topic averaging)
 *  and — past the embedder's token cap — silently lose their tail. Splitting is
 *  structural (no LLM): frontmatter, headings, and top-level list items are the
 *  boundaries; each segment becomes one chunk (no size-based packing — see below).
 *
 *  Determinism is load-bearing, and *edit locality* is its sharp form: re-importing
 *  an unchanged file must yield byte-identical chunk texts (or the near-dup
 *  compaction can't collapse the stale rows), and editing one section must leave
 *  every other chunk untouched. Size-based packing violates the latter — a one-
 *  char edit shifts every downstream boundary — so chunks map 1:1 to segments and
 *  only the edited segment is re-ingested as a new fact. */
export function splitMemoryChunks(raw: string, opts?: { /** files above this length get split (chars) */
  trigger?: number;
}): string[] {
  const trigger = opts?.trigger ?? 1200;
  if (raw.length <= trigger) return [raw];

  // Frontmatter is the file's identity (name/description) — kept attached to the
  // first chunk only. Prepending it to every chunk would make same-file chunks
  // suspiciously similar to each other.
  let body = raw;
  let frontmatter = '';
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      const cut = raw.indexOf('\n', end + 1);
      frontmatter = raw.slice(0, cut === -1 ? raw.length : cut + 1);
      body = raw.slice(frontmatter.length);
    }
  }

  // Segment the body: headings and top-level list items start a segment; paragraph
  // text, sub-bullets and blank lines glue onto the segment above them. A heading
  // sticks to the first item under it (a bare heading chunk carries no meaning on
  // its own). A segment longer than the embedder's token budget simply gets
  // truncated at embed time — force-shredding it would produce context-free
  // fragments.
  const chunks: string[] = [];
  let cur: string[] = [];
  const isHeadingLine = (line: string): boolean => /^#{1,6} /.test(line);
  const curIsHeadingOnly = (): boolean => cur.length > 0 && cur.every(isHeadingLine);
  const flushSeg = (): void => {
    const text = cur.join('\n').trim();
    if (text) chunks.push(text);
    cur = [];
  };
  for (const line of body.split('\n')) {
    const isItem = /^[-*>] /.test(line) || /^\d+\. /.test(line);
    if (isHeadingLine(line) || (isItem && !curIsHeadingOnly())) {
      flushSeg();
      cur.push(line);
    } else {
      cur.push(line);
    }
  }
  flushSeg();
  if (chunks.length > 1 && frontmatter) chunks[0] = `${frontmatter}\n${chunks[0]}`;
  // Nothing splittable was found (e.g. one huge paragraph) → keep the file whole.
  return chunks.length > 1 ? chunks : [raw];
}
