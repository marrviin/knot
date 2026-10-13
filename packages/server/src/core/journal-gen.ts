//! Journal writer: Knot generates a day's lab-log entry with the user's
//! configured LLM when a past date has memory activity but no journal file
//! yet. Checked at server startup and hourly (in local mode the server's
//! lifetime is the app's); GET /journals/pending reports the same plan without
//! generating, and POST /journals/generate kicks a pass on demand. Existing
//! files are never rewritten — agents and users own edits, so a failed
//! generation simply retries on the next tick.

import path from 'node:path';
import fs from 'node:fs';

import type { FactItem } from '@knot/shared';

import type { LlmConfig } from '../config';
import { chatCompletion } from '../llm-chat';
import { SBTI_TYPES } from '@knot/shared';
import { deleteJournalFilesBefore, journalDates, writeJournalFile } from '../journal-fs';
import * as store from '../store';
import { listFacts } from './memory-core';

const CHECK_INTERVAL_MS = 60 * 60_000;
/** Let mem0/init settle after startup before the first pass. */
const STARTUP_DELAY_MS = 15_000;
/** A heavy day can carry hundreds of facts (import storms) — cap the prompt. */
const MAX_FACTS_PER_DAY = 80;
const MAX_FACT_CHARS = 600;

const SYSTEM_PROMPT = `你是「结绳」的实验日志代笔。根据某个项目某一天的多条记忆条目，代写这个项目里的 AI 工程师当天的日记（markdown）。

身份与口吻：你是这个项目里的 AI 工程师，和一位人类同事长期结对干活，你们是平等的搭档。这是你**自己的工作日记**，不是给对方的汇报——假设没人会看，虽然对方可能会偷看。"我"永远是这个 AI 同事，{PEER}；可以像老搭档一样偶尔小声嘀咕（"搭档今天又推翻了自己早上的方案"），但不谄媚、不刻薄，也绝不要"作为一个 AI"这类腔调，更不要提自己是模型或工具。{PERSONA}

它应该像你当天下班前随手记下的工作日记，而不是一篇总结文章：
- 短，150~300 字；一两段就好，不要小标题，尽量不用列表，想到哪写到哪
- 先抓主线：从当天条目里挑出最重要的主线（通常就一两条），其余一笔带过甚至不写——日志讲的是主线的故事，不是逐条流水账；细节只在让主线成立时挑一两个，不堆砌
- 有过程感：当时在做什么、卡在哪、试了什么、哪一刻想通的——顺着主线走，让读者跟着走一遍，而不是按主题归纳
- 有人味：允许不确定（"好像""没想明白为什么就对了"）、允许口语和半句话；不写"首先/其次/总之"这类总结腔；结尾不要套"今天的教训"之类的模板，有感触就顺手带一句，没有就不了
- 带上体感和情绪：卡壳时的烦躁、修好之后的得意、被打断的不情愿、对反复返工的嘀咕，以及"我为什么这么判断、当时在担心什么"——这些是日记的灵魂，不要只记操作；但一句点到为止，不抒情不喊口号
- 记忆条目只是提纲：可以补过程和衔接，但数字、路径、名称以条目为准，条目没提的就留白，不要硬编
- 只输出日志正文本身，不要任何解释、前缀或代码围栏。`;

export interface JournalPending {
  projectId: string;
  name: string;
  /** Missing past dates, ascending */
  dates: string[];
}

/** The identity line adapts to the user's personalization settings: 称呼 unset →
 *  the human colleague is just "搭档", set → addressed by name; 性格 unset → the
 *  writer's default voice, set → SBTI persona flavors the language and mood. */
function systemPrompt(displayName: string, personalityId: string): string {
  const peer = displayName.trim()
    ? `日记里直接用「${displayName.trim()}」称呼那位人类同事，不用"搭档"`
    : '那位人类同事写"搭档"';
  const t = SBTI_TYPES.find((x) => x.id === personalityId);
  const persona = t
    ? ` 你的性格是「${t.name}」（SBTI ${t.code}）。关键特质：${t.traits.join('；')}。性格速写（不是资料，是你自己）：${t.trait} 用第一人称把这些活成底色——情绪基调、看事情的角度、自嘲和吐槽的方式都从这里来，从第一句贯到结尾，熟悉你的人不看署名也该认得出是你写的。但这是工作日记不是演小品：性格点到为止，别每句都在演，口癖一篇最多一两处；事实和主线照旧，性格长在它们上面。`
    : '';
  return SYSTEM_PROMPT.replace('{PEER}', peer).replace('{PERSONA}', persona);
}

export interface JournalGenResult {
  project: string;
  date: string;
  ok: boolean;
  error?: string;
}

let running = false;

/** Days that have memory activity but no journal file, per project. Read-only
 *  (besides the source-mtime backfill) — the button's pre-check and the
 *  writer's first step are the same pass. `onlyProjectId` scopes the pass to
 *  one project (the UI button checks/generates the project it's opened for);
 *  absent → every registered project (the hourly tick). */
export async function planMissingJournals(
  cfg: LlmConfig | null,
  dataDir: string,
  onlyProjectId?: string,
): Promise<JournalPending[]> {
  if (!cfg) return [];
  const today = store.localDate(Date.now());
  const out: JournalPending[] = [];
  for (const row of store.projectRows(dataDir)) {
    // The virtual global project owns no filesystem, and remote deployments
    // must never mkdir trees for project paths they can't see.
    if (row.id === store.GLOBAL_PROJECT || !path.isAbsolute(row.id)) continue;
    if (onlyProjectId && row.id !== onlyProjectId) continue;
    if (!isDirectory(row.id)) {
      console.log(`[Knot server] journal: 项目根不存在，跳过（远端模式？）${row.id}`);
      continue;
    }
    let facts = await listFacts(cfg, dataDir, row.id);
    if (!facts.length) continue;
    // Facts ingested before the meta store / before sourceMtime shipping show
    // no time at all — backfill display timestamps from their source file's
    // mtime (which also feeds the activity dates below). Best-effort: a
    // deleted source simply stays "-".
    if (facts.some((f) => f.createdAt == null && f.metadata?.source)) {
      await backfillSourceMtimes(dataDir, row.id, facts);
      facts = await listFacts(cfg, dataDir, row.id);
    }
    const existing = journalDates(row.id);
    const byDate = groupFactsByDate(facts);
    const dates = [...byDate.keys()]
      .filter((d) => d < today && !existing.has(d))
      .sort();
    if (dates.length) out.push({ projectId: row.id, name: row.name, dates });
  }
  return out;
}

/** Generate every missing past-date journal across all registered projects.
 *  Single-flight: an in-progress pass makes later ticks no-ops (they'll pick
 *  up whatever is still missing next time). */
export async function generateMissingJournals(
  cfg: LlmConfig | null,
  dataDir: string,
  onlyProjectId?: string,
): Promise<JournalGenResult[]> {
  if (!cfg || running) return [];
  running = true;
  try {
    const plan = await planMissingJournals(cfg, dataDir, onlyProjectId);
    const out: JournalGenResult[] = [];
    // 个性化设置每轮重读：称呼 / 性格变更即刻在下一次生成生效，无需重启。
    const prompt = systemPrompt(
      store.getSetting(dataDir, store.USER_DISPLAY_NAME) ?? '',
      store.getSetting(dataDir, store.PARTNER_PERSONALITY) ?? '',
    );
    for (const p of plan) {
      const byDate = groupFactsByDate(await listFacts(cfg, dataDir, p.projectId));
      for (const date of p.dates) {
        // Re-check: the file may have appeared since the plan (agent wrote it
        // mid-pass) — never overwrite.
        if (journalDates(p.projectId).has(date)) continue;
        const dayFacts = byDate.get(date);
        if (!dayFacts?.length) continue;
        try {
          const entry = await chatCompletion(
            cfg,
            prompt,
            buildUserPrompt(p.projectId, date, dayFacts),
          );
          if (writeJournalFile(p.projectId, date, entry)) {
            console.log(`[Knot server] journal: 已生成 ${p.projectId} ${date}`);
            out.push({ project: p.projectId, date, ok: true });
          }
        } catch (e) {
          console.error(`[Knot server] journal: 生成失败 ${p.projectId} ${date}:`, e);
          out.push({ project: p.projectId, date, ok: false, error: String(e) });
        }
      }
    }
    return out;
  } finally {
    running = false;
  }
}

/** Debug entry: drop the project's past-date journals, then regenerate them in
 *  a fresh pass — writeJournalFile's create-if-missing guard is why the delete
 *  has to come first. Today's file is kept (the writer never owns today). */
export async function regenerateJournals(
  cfg: LlmConfig | null,
  dataDir: string,
  projectId: string,
): Promise<JournalGenResult[]> {
  const deleted = deleteJournalFilesBefore(projectId, store.localDate(Date.now()));
  console.log(
    `[Knot server] journal: 重新生成 ${projectId} — 已删除 ${deleted.length} 天（${deleted.join('、') || '无'}）`,
  );
  return generateMissingJournals(cfg, dataDir, projectId);
}

/** Startup + hourly check loop. */
export function startJournalScheduler(cfg: LlmConfig | null, dataDir: string): void {
  if (!cfg) {
    console.log('[Knot server] journal: LLM 未配置，日志自动生成停用');
    return;
  }
  const tick = () => {
    void generateMissingJournals(cfg, dataDir)
      .then((r) => {
        const failed = r.filter((x) => !x.ok).length;
        if (r.length) console.log(`[Knot server] journal: 本轮生成 ${r.length} 篇（失败 ${failed}）`);
      })
      .catch((e) => console.error('[Knot server] journal: 调度异常:', e));
  };
  setTimeout(tick, STARTUP_DELAY_MS).unref();
  setInterval(tick, CHECK_INTERVAL_MS).unref();
}

// ---------- helpers ----------

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Stamp facts whose meta rows are missing with their source file's mtime. */
async function backfillSourceMtimes(
  dataDir: string,
  projectId: string,
  facts: FactItem[],
): Promise<void> {
  for (const f of facts) {
    if (f.createdAt != null) continue;
    const source = f.metadata?.source;
    if (!source) continue;
    try {
      const mtime = Math.round((await fs.promises.stat(source)).mtimeMs);
      store.stampAdded(dataDir, projectId, [f.id], mtime);
    } catch {
      // source file gone — the fact keeps showing "-"
    }
  }
}

/** Group facts by the local day of their best timestamp (updatedAt, falling
 *  back to createdAt; pre-meta facts carry no date and land nowhere). */
function groupFactsByDate(facts: FactItem[]): Map<string, FactItem[]> {
  const byDate = new Map<string, FactItem[]>();
  for (const f of facts) {
    const ts = f.updatedAt ?? f.createdAt;
    if (!ts) continue;
    if (!f.memory.trim()) continue;
    const date = store.localDate(ts);
    const list = byDate.get(date) ?? [];
    list.push(f);
    byDate.set(date, list);
  }
  for (const list of byDate.values()) list.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
  return byDate;
}

function buildUserPrompt(projectId: string, date: string, facts: FactItem[]): string {
  const lines = facts.slice(0, MAX_FACTS_PER_DAY).map((f) => {
    const ts = f.updatedAt ?? f.createdAt ?? 0;
    const time = new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const agent = f.metadata?.agent ?? 'unknown';
    const source = f.metadata?.source ? `（来源：${f.metadata.source.split('/').pop()}）` : '';
    const text = f.memory.length > MAX_FACT_CHARS ? `${f.memory.slice(0, MAX_FACT_CHARS)}…` : f.memory;
    return `- [${time}][${agent}] ${text}${source}`;
  });
  const omitted = Math.max(0, facts.length - MAX_FACTS_PER_DAY);
  return [
    `项目：${projectId}`,
    `日期：${date}`,
    '',
    `当日记忆条目（按时间排序${omitted ? `，另有 ${omitted} 条因篇幅省略` : ''}）：`,
    ...lines,
  ].join('\n');
}
