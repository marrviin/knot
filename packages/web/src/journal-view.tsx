/**
 * Journal reader: the project's .knot/logs/YYYY-MM-DD.md entries (read server
 * /projects/:id/journals) as one continuous stream, newest first — the lab-log
 * reading experience. Agents write the files directly; changes push a
 * facts-changed event, which re-reads the list.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Empty, Spin } from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";

import * as api from "./api";
import type { JournalEntry } from "./types";
import { JournalMd } from "./journal-md";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

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

export function JournalView({
  project,
  onNotify,
}: {
  project: { path: string };
  onNotify: (msg: string, type?: "info" | "error") => void;
}) {
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  /** True while a manual generation is being watched for results */
  const [generating, setGenerating] = useState(false);
  const genSeq = useRef(0);

  const load = useCallback(() => {
    api
      .listJournals(project.path)
      .then(setEntries)
      .catch((e) => onNotify(`加载日志失败: ${e?.message ?? e}`, "error"));
  }, [project.path, onNotify]);

  // Debug regeneration: delete the project's past-date journals server-side,
  // then regenerate them from the same memories. Deletion lands immediately
  // (the list empties), files refill as the LLM writes them — poll until the
  // original dates are all back (or, from nothing, the first one lands).
  const triggerGenerate = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    const seq = ++genSeq.current;
    try {
      const before = (entries ?? []).map((e) => e.date).join(",");
      await api.regenerateJournals(project.path);
      onNotify("已删除现有日记，正在重新生成…");
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 8000));
        if (seq !== genSeq.current) return; // superseded by a newer click
        const fresh = await api.listJournals(project.path);
        setEntries(fresh);
        const now = fresh.map((e) => e.date).join(",");
        if (before ? now === before : now) break;
      }
    } catch (e: any) {
      onNotify(`重新生成失败: ${e?.message ?? e}`, "error");
    } finally {
      if (seq === genSeq.current) setGenerating(false);
    }
  }, [generating, entries, project.path, onNotify]);

  useEffect(() => {
    load();
    // Desktop only: the refresh event comes from the main process's watcher
    // (the browser build has no window.knot and just misses live refresh).
    if (typeof (globalThis as { knot?: unknown }).knot === "undefined") return;
    return window.knot.listen("knot://facts-changed", (e: { path: string }) => {
      if (e.path === project.path) load();
    });
  }, [load, project.path]);

  // Debug entry (临时调试用): wipes and rewrites this project's past-date
  // journals from the same memories
  const genButton = (
    <Button
      size="small"
      icon={<ThunderboltOutlined spin={generating} />}
      onClick={() => void triggerGenerate()}
      disabled={generating}
      title="调试用：删除本项目过去的日记并从同样的记忆条目重新生成（今天的日记不受影响）"
    >
      {generating ? "重新生成中…" : "重新生成"}
    </Button>
  );

  if (entries === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spin />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有日记" />
      </div>
    );
  }

  return (
    <div className="jnl-paper mx-auto max-w-3xl px-8 pb-10 pt-4">
      <div className="mb-2 flex justify-end">{genButton}</div>
      {entries.map((entry) => {
        const rel = dayRelative(entry.date);
        return (
          <section key={entry.date} className="pt-6 first:pt-2">
            <div className="jnl-date mb-1 flex items-baseline gap-2 pb-1">
              <h3 className="m-0 text-xl font-semibold">
                {dayLabel(entry.date)}
              </h3>
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
            <JournalMd text={entry.content} />
          </section>
        );
      })}
    </div>
  );
}
