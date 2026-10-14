/**
 * Standalone journal-book window (?window=journal&project=…&date=…): the
 * project's diary as an open notebook on a desk — fixed-size two-page spread,
 * 3D page flips around the spine. Click the left page to flip back, the right
 * page to flip forward (←/→ keys work too). Opened by clicking a journal card;
 * the book opens directly at the clicked day (no animated approach). A
 * re-open event (journal://book-open) retargets the running book instead of
 * recreating the window.
 *
 * Leaf model (physical, like a real book): spread 0 shows a blank left page
 * and entry 0 on the right; after one flip the left page is entry 1 and the
 * right is entry 2 — spread k prints entry 2k-1 on the left and 2k on the
 * right. Leaf i carries entry 2i on its front (right of spread i) and entry
 * 2i+1 on its back (left of spread i+1). Stacking is done with translateZ
 * (depth-sorting in the preserve-3d context), not z-index; both visible
 * pages always rest at the same height so the spread projects aligned.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Spin } from "antd";

import { ThemeProviders } from "./theme";
import * as api from "./api";
import type { JournalEntry } from "./types";
import { JournalMd } from "./journal-md";
import { DateHeader } from "./journal-view";

/** Leaf turn duration — must match the .jnb-turn/.jnb-bend CSS duration */
const FLIP_MS = 520;

/** Spread index that shows entry p. Like a real book: the first entry is
 *  alone on the right page (spread 0, left blank); after one flip the left
 *  page is entry 2 and the right is entry 3 — spread k prints entry 2k-1 on
 *  the left and 2k on the right, so the target is ⌈p/2⌉ (clamped by caller).
 *  Unknown/absent date → the newest spread. */
function spreadFor(sorted: JournalEntry[], date: string | null): number {
  const p = date ? sorted.findIndex((e) => e.date === date) : -1;
  if (p >= 0) return Math.ceil(p / 2);
  return Math.ceil((sorted.length - 1) / 2);
}

/** One printed page: the day's date header + markdown body. Zoom is set
 *  book-wide (see BookStage's fitAll) so every page shares the same type
 *  size; no entry → a blank sheet. */
function PageBody({ entry }: { entry?: JournalEntry }) {
  if (!entry) {
    return (
      <div className="jnb-page-inner">
        <div className="jnb-blank">·</div>
      </div>
    );
  }
  return (
    <div className="jnb-page-inner">
      <div className="jnb-scroll px-9 py-7">
        <DateHeader date={entry.date} />
        <JournalMd text={entry.content} />
      </div>
    </div>
  );
}

function Desk({ children }: { children: ReactNode }) {
  return <div className="jnb-desk">{children}</div>;
}

export function JournalBookWindow() {
  return (
    <ThemeProviders>
      <BookRoot />
    </ThemeProviders>
  );
}

function BookRoot() {
  // Window URL carries the initial project + day (set by the BrowserWindow)
  const initial = useMemo(
    () => new URLSearchParams(window.location.search),
    [],
  );
  const [project, setProject] = useState(() => initial.get("project") ?? "");
  /** Day to land on after the current load lands (opening target spread) */
  const [openDate, setOpenDate] = useState<string | null>(() =>
    initial.get("date"),
  );
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One-time memory-endpoint bootstrap before the first HTTP read — server-backed
  // reads would otherwise throw「未连接」even when the service is up (same as the
  // settings window's inner shell).
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void api
      .initMemoryEndpoint()
      .catch(() => false)
      .finally(() => setReady(true));
  }, []);

  const load = useCallback((path: string) => {
    setEntries(null);
    setError(null);
    api
      .listJournals(path)
      .then((l) => setEntries([...l].sort((a, b) => (a.date < b.date ? -1 : 1))))
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);

  useEffect(() => {
    if (ready) load(project);
  }, [ready, project, load]);

  // Card clicked while this window is already up: another project reloads (the
  // target spread recomputes), the same project just turns to that day.
  const jumpRef = useRef<(date: string) => void>(() => {});
  const registerJump = useCallback((fn: (date: string) => void) => {
    jumpRef.current = fn;
  }, []);
  useEffect(() => {
    return api.onBookOpen((p) => {
      if (p.project !== project) {
        setProject(p.project);
        setOpenDate(p.date);
      } else {
        jumpRef.current(p.date);
      }
    });
  }, [project]);

  if (error)
    return (
      <Desk>
        <p className="jnb-note">日记加载失败：{error}</p>
      </Desk>
    );
  if (!entries)
    return (
      <Desk>
        <Spin />
      </Desk>
    );
  if (entries.length === 0)
    return (
      <Desk>
        <p className="jnb-note">这个项目还没有日记</p>
      </Desk>
    );
  return (
    <BookStage
      sorted={entries}
      targetDate={openDate}
      registerJump={registerJump}
    />
  );
}

function BookStage({
  sorted,
  targetDate,
  registerJump,
}: {
  sorted: JournalEntry[];
  targetDate: string | null;
  registerJump: (fn: (date: string) => void) => void;
}) {
  const n = sorted.length;
  /** Leaf i: entry 2i on the front (right of spread i), entry 2i+1 on the
   *  back (left of spread i+1) */
  const leafCount = Math.ceil(n / 2);
  /** Last meaningful spread: even n ends with entry n-1 on a left page (all
   *  leaves flipped); odd n ends with a full spread one flip earlier */
  const maxSpread = Math.floor(n / 2);
  /** Resting z step between stacked pages (tiny — pages of one stack recess
   *  0.5px each for depth ordering). Both stacks' TOP pages always rest at
   *  zTop, so the two visible pages project identically and the spread stays
   *  aligned at the spine no matter how uneven the stacks are; deeper pages
   *  shrink imperceptibly behind the top sheet, like a real book's page
   *  edges. (Fixed 2px steps used to put the two tops at different depths,
   *  which perspective scaled differently — visibly misaligned spreads.) */
  const Z_STEP = 0.5;
  const zTop = leafCount * Z_STEP;
  const [flipped, setFlipped] = useState(0);
  const flippedRef = useRef(0);
  /** Leaf mid-turn, its direction and the z heights the flight interpolates
   *  between — drives the keyframe animation class */
  const [turning, setTurning] = useState<{
    idx: number;
    dir: "fwd" | "back";
    from: number;
    to: number;
  } | null>(null);
  const turnTimer = useRef(0);
  const bookRef = useRef<HTMLDivElement | null>(null);

  // One type size for the whole book: fit every page individually, then apply
  // the smallest fitting zoom to ALL pages — long days still fit the sheet,
  // short ones just leave whitespace, like a real notebook. Runs after first
  // paint (guards a zero-height first measure) and again after the handwriting
  // font swaps in — its metrics differ from the fallback the first measure
  // ran with.
  useEffect(() => {
    const fitAll = () => {
      const pages = bookRef.current?.querySelectorAll<HTMLElement>(".jnb-scroll");
      if (!pages?.length) return;
      let min = 0.9;
      for (const el of pages) {
        let z = 0.9;
        el.style.zoom = String(z);
        while (z > 0.5 && el.scrollHeight > el.clientHeight + 1) {
          z -= 0.05;
          el.style.zoom = String(z);
        }
        if (z < min) min = z;
      }
      pages.forEach((el) => {
        el.style.zoom = String(min);
      });
    };
    fitAll();
    const raf = requestAnimationFrame(fitAll);
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) fitAll();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [sorted]);

  const flipTo = useCallback(
    (target: number) => {
      const next = Math.max(0, Math.min(maxSpread, target));
      const cur = flippedRef.current;
      if (next === cur) return;
      flippedRef.current = next;
      // Flight heights: a turning sheet always leaves from its stack's top
      // and lands on the other stack's top — both are zTop, so a normal
      // one-page turn keeps a constant height (multi-spread jumps descend
      // onto their deeper slot in the new stack, still above every page).
      const idx = Math.min(cur, next);
      const dir = next > cur ? "fwd" : "back";
      setTurning({
        idx,
        dir,
        from: dir === "fwd" ? zTop : zTop - (cur - 1 - next) * Z_STEP,
        to: dir === "fwd" ? zTop - (next - 1 - idx) * Z_STEP : zTop,
      });
      setFlipped(next);
      window.clearTimeout(turnTimer.current);
      turnTimer.current = window.setTimeout(
        () => setTurning(null),
        FLIP_MS + 60,
      );
    },
    [maxSpread, zTop],
  );

  // Open (and re-target) directly at the clicked day — no animated approach.
  // Runs once per load / book-open retarget.
  useEffect(() => {
    const t = Math.min(maxSpread, spreadFor(sorted, targetDate));
    flippedRef.current = t;
    setFlipped(t);
  }, [sorted, targetDate, maxSpread]);

  const prev = useCallback(() => flipTo(flippedRef.current - 1), [flipTo]);
  const next = useCallback(() => flipTo(flippedRef.current + 1), [flipTo]);

  // ── Drag-to-move ────────────────────────────────────────────────────────────
  // The window has no title bar, so the book itself is the handle: a left
  // press anywhere on it arms a drag, and once the pointer passes a few px the
  // window follows via moveWindow (incremental screen deltas). A press
  // released under the threshold stays an ordinary click (page flip); the
  // click that trails a real drag is swallowed in capture phase so letting go
  // never flips a page. CSS -webkit-app-region: drag is not an option — drag
  // regions swallow clicks entirely.
  const dragRef = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);
  const swallowClickRef = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.screenX - d.lastX;
      const dy = e.screenY - d.lastY;
      d.lastX = e.screenX;
      d.lastY = e.screenY;
      if (!d.moved) {
        if (Math.hypot(e.screenX - d.startX, e.screenY - d.startY) < 4) return;
        d.moved = true;
        document.body.classList.add("jnb-dragging");
      }
      api.moveWindow(dx, dy);
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d?.moved) return;
      document.body.classList.remove("jnb-dragging");
      swallowClickRef.current = true;
      // Click fires right after mouseup — one macrotask is enough to bridge it.
      window.setTimeout(() => {
        swallowClickRef.current = false;
      }, 0);
    };
    // Capture at document level: React 17+ handlers sit on the root, so a
    // capture-phase stopPropagation here beats every onClick on the pages.
    const onClick = (e: MouseEvent) => {
      if (!swallowClickRef.current) return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.removeEventListener("click", onClick, true);
      document.body.classList.remove("jnb-dragging");
    };
  }, []);
  const onBookMouseDown = useCallback((e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    // preventDefault: no text selection / focus while the press may become a drag
    e.preventDefault();
    dragRef.current = {
      startX: e.screenX,
      startY: e.screenY,
      lastX: e.screenX,
      lastY: e.screenY,
      moved: false,
    };
  }, []);

  // Keyboard paging (← → Home End)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "Home") flipTo(0);
      else if (e.key === "End") flipTo(maxSpread);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, flipTo, maxSpread]);

  useEffect(() => {
    registerJump((date: string) => flipTo(spreadFor(sorted, date)));
  }, [registerJump, flipTo, sorted]);

  const leaves = [];
  for (let i = 0; i < leafCount; i++) {
    const isTurning = turning?.idx === i;
    // Resting depth: each stack's top page sits at zTop, pages beneath it
    // recess one Z_STEP each (see the Z_STEP comment above). While turning,
    // the keyframe interpolates z linearly from --z-from to --z-to (set in
    // flipTo — both are stack tops, so a normal turn flies level).
    const restZ =
      flipped > i
        ? zTop - (flipped - 1 - i) * Z_STEP
        : zTop - (i - flipped) * Z_STEP;
    const style = {
      transform: isTurning
        ? undefined
        : `translateZ(${restZ}px) rotateY(${flipped > i ? -180 : 0}deg)`,
      ...(isTurning
        ? {
            "--z-from": `${turning.from}px`,
            "--z-to": `${turning.to}px`,
          }
        : {}),
    } as CSSProperties;
    leaves.push(
      <div
        key={i}
        className={`jnb-leaf${isTurning ? ` turn-${turning.dir}` : ""}`}
        style={style}
      >
        {/* Bend wrapper: mid-flight it trails the leaf's rotation a few
            degrees (see .jnb-bend in components.css), so the free edge lags
            and the sheet flexes like paper instead of a rigid lid */}
        <div className="jnb-bend">
          <div className="jnb-face jnb-front" onClick={next}>
            <PageBody entry={sorted[2 * i]} />
          </div>
          <div className="jnb-face jnb-back" onClick={prev}>
            <PageBody entry={sorted[2 * i + 1]} />
          </div>
        </div>
      </div>,
    );
  }

  return (
    <Desk>
      <div ref={bookRef} className="jnb-book" onMouseDown={onBookMouseDown}>
        {/* Static bases: both blank paper. The left base IS spread 0's empty
            left page; the right base shows through mid-turn and on the last
            spread when the entry count is odd */}
        <div className="jnb-base jnb-base-l" onClick={prev} />
        <div className="jnb-base jnb-base-r" onClick={next} />
        {leaves}
      </div>
    </Desk>
  );
}
