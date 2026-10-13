/**
 * Block-level markdown rendering for journal entries (dependency-free, hand-written
 * line parser — same philosophy as inline-md.tsx): headings, unordered/ordered
 * lists, fenced code, blockquotes, horizontal rules, paragraphs. All inline
 * syntax inside text runs through InlineMd; literal text stays React-escaped,
 * so there's no XSS surface.
 */
import type { ReactNode } from "react";

import { InlineMd } from "./inline-md";

type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" };

/** Split the raw markdown into block-level tokens (line-based, no nesting). */
function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // Fenced code: ``` or ~~~ (closing fence must be at least as long)
    const fence = /^(`{3,}|~{3,})\s*(\S*)\s*$/.exec(line);
    if (fence) {
      const mark = fence[1][0].repeat(3);
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(mark)) body.push(lines[i++]);
      i++; // skip the closing fence (or run off the end — unclosed fence still renders)
      blocks.push({ kind: "code", lang: fence[2], lines: body });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: heading[2].trim(),
      });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]))
        body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", lines: body });
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      blocks.push({ kind: "ul", items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push({ kind: "ol", items });
      continue;
    }
    // Paragraph: consecutive non-blank, non-special lines (soft line breaks kept)
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^(`{3,}|~{3,})/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i])
    )
      para.push(lines[i++]);
    blocks.push({ kind: "paragraph", lines: para });
  }
  return blocks;
}

const HEADING_CLASS: Record<number, string> = {
  1: "mt-6 mb-3 text-lg font-semibold",
  2: "mt-5 mb-2.5 text-[15px] font-semibold",
  3: "mt-4 mb-2 text-sm font-semibold",
  4: "mt-3 mb-1.5 text-sm font-semibold",
  5: "mt-3 mb-1.5 text-[13px] font-semibold",
  6: "mt-3 mb-1.5 text-[13px] font-semibold text-muted",
};

function renderBlock(b: Block, keyPrefix: string): ReactNode {
  const k = `${keyPrefix}`;
  switch (b.kind) {
    case "heading": {
      const Tag = `h${b.level}` as const;
      return (
        <Tag key={k} className={`${HEADING_CLASS[b.level]} text-fg`}>
          <InlineMd text={b.text} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={k} className="my-3 text-sm leading-7 whitespace-pre-wrap wrap-anywhere first:mt-0">
          {b.lines.map((l, i) => (
            <InlineMd key={i} text={l} />
          ))}
        </p>
      );
    case "ul":
      return (
        <ul key={k} className="my-3 list-disc space-y-1 pl-5 text-sm leading-7">
          {b.items.map((it, i) => (
            <li key={i}>
              <InlineMd text={it} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={k} className="my-3 list-decimal space-y-1 pl-5 text-sm leading-7">
          {b.items.map((it, i) => (
            <li key={i}>
              <InlineMd text={it} />
            </li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre
          key={k}
          className="my-3 overflow-x-auto rounded-lg bg-fill p-3 text-xs leading-6"
        >
          <code className="font-mono">{b.lines.join("\n")}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote
          key={k}
          className="my-3 border-l-2 border-(--color-line) pl-3 text-sm leading-7 text-muted"
        >
          {b.lines.map((l, i) => (
            <InlineMd key={i} text={l} />
          ))}
        </blockquote>
      );
    case "hr":
      return <hr key={k} className="my-4 border-(--color-line)" />;
  }
}

export function JournalMd({ text }: { text: string }) {
  return <>{parseBlocks(text).map((b, i) => renderBlock(b, `b${i}`))}</>;
}
