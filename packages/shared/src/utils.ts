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

/** Pair up near-duplicate items by embedding cosine. Threshold 0.95 is calibrated
 *  against live embo-01 vectors: near-identical re-extractions score 0.96+, while
 *  related-but-distinct memories top out at ~0.82 — but paraphrase-level dups can
 *  score as low as 0.56/0.71, so nothing below 0.95 is safely separable. Items
 *  earlier in the list win: the caller puts the preferred canonical first.
 *  Returns dupId → canonicalId. */
// (exported for tests)
export function findNearDupIds(
  items: { id: string }[],
  vectors: Map<string, number[]>,
  threshold = 0.95,
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
