/**
 * Journal reader: the project's .journal/logs/YYYY-MM-DD.md entries (read server
 * /projects/:id/journals) as a stack of day cards, newest first — the lab-log
 * reading experience. Agents write the files directly; changes push a
 * facts-changed event, which re-reads the list.
 *
 * Owed entries (memory activity, no file yet) are planned up front via the
 * cheap /journals/pending check: their day cards render immediately with an
 * estimated progress bar in the body while the writer fills them in (the
 * generate kick is fire-and-forget; a poll swaps each card for real content
 * as its file lands).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Empty, Progress, Spin } from "antd";

import * as api from "./api";
import type { JournalEntry } from "./types";
import { JournalMd } from "./journal-md";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** How often the generation watcher re-lists journals to catch landed files */
const GENERATION_POLL_MS = 3000;
/** Measured pace of one generated entry (~70 s in the M3 run); only drives
 *  the progress bar's estimate — completion is detected by the poll. */
const PER_ENTRY_MS = 70_000;
/** The writer generates JOURNAL_CONCURRENCY entries in parallel (server-side
 *  pool); the estimate models the same wave rhythm. */
const CONCURRENCY = 3;

/** "2026-10-13" → 「2026年10月13日 · 周二」 (parsed as local time — the date
 *  IS the local day the file was written for). */
function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${y}年${m}月${d}日 · ${WEEKDAYS[dt.getDay()]}`;
}

/** Relative badge for today/yesterday, null otherwise */
function dayRelative(date: string): string | null {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - dt.getTime()) / 86_400_000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  return null;
}

/** Estimated percent for one owed card: entries run in waves of CONCURRENCY,
 *  so the i-th owed date finishes around (floor(i/C)+1) × PER_ENTRY_MS after
 *  the kick. Clamped to 3~95 so it never lies about being done — the poll
 *  snaps it away. */
function pendingPercent(date: string, owing: string[], startedAt: number): number {
  const i = owing.indexOf(date);
  if (i < 0 || !startedAt) return 3;
  const elapsed = Date.now() - startedAt;
  const wave = Math.floor(i / CONCURRENCY);
  const p = (elapsed - wave * PER_ENTRY_MS) / PER_ENTRY_MS;
  return Math.round(Math.min(95, Math.max(3, p * 100)));
}

/** Static hand-drawn underline for the date header (same every render — no
 *  jitter needed for a fixed label length). */
const DATE_UNDERLINE =
  "M 1.5 4.5 Q 15 2.5 30 4 Q 50 6 70 3.5 Q 85 2 98.5 4.5";

/** 红笔圈注的「今天/昨天」徽章（手绘椭圆，静态路径） */
function RedCircleBadge({ text }: { text: string }) {
  return (
    <span className="jnl-badge">
      {text}
      <svg className="jnl-mark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
        <path
          d="M 4 15 C 2 8, 20 2.5, 52 2.5 C 84 2.5, 99 8, 97.5 15 C 96 22, 75 26, 48 25.5 C 22 25, 6 21.5, 4 15"
          fill="none"
          stroke="var(--jnl-red)"
          strokeWidth={1.6}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </span>
  );
}

/** Date header + rule shared by real and still-being-written cards (also used
 *  by the standalone journal-book window's pages) */
export function DateHeader({ date }: { date: string }) {
  const rel = dayRelative(date);
  return (
    <>
      <div className="jnl-date mb-1 flex items-baseline gap-2 pb-1">
        <h3 className="m-0 text-xl font-semibold">{dayLabel(date)}</h3>
        {rel && <RedCircleBadge text={rel} />}
      </div>
      <svg className="jnl-date-rule" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
        <path
          d={DATE_UNDERLINE}
          fill="none"
          stroke="var(--jnl-pen)"
          strokeWidth={1.4}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </>
  );
}

/** One owed day: header now, body is the generation's estimated progress */
function PendingCard({
  date,
  owing,
  startedAt,
  className = "px-10 py-6",
}: {
  date: string;
  owing: string[];
  startedAt: number;
  /** Card layout classes (padding/spacing) — callers match the entry cards */
  className?: string;
}) {
  return (
    <section className={`jnl-paper ${className}`}>
      <DateHeader date={date} />
      <div className="mt-5">
        <Progress percent={pendingPercent(date, owing, startedAt)} status="active" showInfo={false} size="small" />
        <div className="mt-1 text-xs opacity-50">正在补写这一天的日记…</div>
      </div>
    </section>
  );
}

export function JournalView({
  project,
  onNotify,
  regenNonce = 0,
  layout = "list",
}: {
  project: { path: string };
  onNotify: (msg: string, type?: "info" | "error") => void;
  /** Bumped by the debug regenerate button: its server call deletes the files
   *  synchronously before returning, so the bump re-runs this planner — the
   *  owed cards take over from the freshly deleted dates. */
  regenNonce?: number;
  /** Reading layout: "list" = single-column day stack; "grid" = equal-width
   *  responsive grid (1/2/3 columns by breakpoint), each card its own height. */
  layout?: "list" | "grid";
}) {
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  /** Days this project still owes a journal (ascending from the server),
   *  removed one by one as the poll sees their files land */
  const [owing, setOwing] = useState<string[]>([]);
  const owingRef = useRef<string[]>([]);
  /** Monotonic start of the current generation run — progress estimate base */
  const [startedAt, setStartedAt] = useState(0);
  const seqRef = useRef(0);
  const kickedRef = useRef(false);

  const load = useCallback(() => {
    api
      .listJournals(project.path)
      .then(setEntries)
      .catch((e) => onNotify(`加载日志失败: ${e?.message ?? e}`, "error"));
  }, [project.path, onNotify]);

  useEffect(() => {
    load();
    // Desktop only: the refresh event comes from the main process's watcher
    // (the browser build has no window.journal and just misses live refresh).
    if (typeof (globalThis as { journal?: unknown }).journal === "undefined") return;
    return window.journal.listen("journal://facts-changed", (e: { path: string }) => {
      if (e.path === project.path) load();
    });
  }, [load, project.path]);

  // Owed-day planner: the pending check is LLM-free, so the cards can render
  // before any content exists. Kick the writer once, then poll until every
  // owed date has a file (the while loop ends as soon as owing drains). Also
  // re-lists entries once up front — after a regenerate's synchronous deletion
  // this is what clears the removed days from the stack.
  useEffect(() => {
    const seq = ++seqRef.current;
    let cancelled = false;
    owingRef.current = [];
    setOwing([]);
    setStartedAt(0);
    kickedRef.current = false;

    const reconcile = (list: JournalEntry[]) => {
      const have = new Set(list.map((e) => e.date));
      const left = owingRef.current.filter((d) => !have.has(d));
      owingRef.current = left;
      setOwing(left);
    };

    (async () => {
      try {
        const [pend, list] = await Promise.all([
          api.getJournalPending(project.path),
          api.listJournals(project.path).catch(() => null),
        ]);
        if (cancelled || seq !== seqRef.current) return;
        if (list) setEntries(list);
        const dates = pend.find((p) => p.projectId === project.path)?.dates ?? [];
        if (!dates.length) return;
        owingRef.current = dates;
        setOwing(dates);
        setStartedAt(Date.now());
        if (!kickedRef.current) {
          kickedRef.current = true;
          api.generateJournals(project.path).catch(() => {});
        }
        while (!cancelled && seq === seqRef.current && owingRef.current.length) {
          await new Promise((r) => setTimeout(r, GENERATION_POLL_MS));
          if (cancelled || seq !== seqRef.current) return;
          const list = await api.listJournals(project.path);
          if (cancelled || seq !== seqRef.current) return;
          setEntries(list);
          reconcile(list);
        }
      } catch {
        // pending 检查失败不打扰用户：正常读路径已兜底，下次进页面再试
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [project.path, regenNonce]);

  // Animate the progress estimate once a second while anything is owed
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!owing.length) return;
    const t = setInterval(() => forceTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [owing.length]);

  if (entries === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spin />
      </div>
    );
  }

  if (entries.length === 0 && owing.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有日记" />
      </div>
    );
  }

  // Merge real entries and owed days into one newest-first stack — the owed
  // cards sit in the timeline where their content will appear
  const rows: { date: string; entry?: JournalEntry }[] = [
    ...entries.map((e) => ({ date: e.date, entry: e })),
    ...owing.map((d) => ({ date: d })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));

  // Grid narrows each card, so the paper's inner padding tightens a notch
  // (list mode keeps the roomier single-column padding).
  const cardCls = layout === "grid" ? "px-7 py-6" : "px-10 py-6";

  return (
    <div className={`mx-auto px-8 pb-10 pt-4 ${layout === "grid" ? "max-w-6xl" : "max-w-3xl"}`}>
      <div
        className={
          layout === "grid"
            ? // Equal-width cells; items-start keeps each paper at its own
              // height instead of stretching to the row's tallest.
              "grid grid-cols-1 items-start gap-6 md:grid-cols-2 2xl:grid-cols-3"
            : "flex flex-col gap-6"
        }
      >
        {rows.map(({ date, entry }) =>
          entry ? (
            <section
              key={date}
              className={`jnl-paper ${cardCls} cursor-pointer transition-shadow hover:shadow-lg`}
              title="打开日记本"
              onClick={() => api.openJournalWindow(project.path, date)}
            >
              <DateHeader date={date} />
              <JournalMd text={entry.content} />
            </section>
          ) : (
            <PendingCard key={date} date={date} owing={owing} startedAt={startedAt} className={cardCls} />
          ),
        )}
      </div>
    </div>
  );
}
