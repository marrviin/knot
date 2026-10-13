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
    <div className="mx-auto max-w-3xl pb-8">
      <div className="mb-2 flex justify-end">{genButton}</div>
      {entries.map((entry) => {
        const rel = dayRelative(entry.date);
        return (
          <section key={entry.date} className="pt-6 first:pt-2">
            <div className="mb-1 flex items-baseline gap-2 border-b border-line pb-2">
              <h3 className="m-0 text-[15px] font-semibold text-fg">
                {dayLabel(entry.date)}
              </h3>
              {rel && (
                <span className="text-xs text-accent" title="最近更新">
                  {rel}
                </span>
              )}
            </div>
            <JournalMd text={entry.content} />
          </section>
        );
      })}
    </div>
  );
}
