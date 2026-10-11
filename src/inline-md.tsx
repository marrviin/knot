/**
 * Inline markdown rendering (dependency-free, hand-written tokenizer): supports
 * `code`, **bold**, *italic*, ~~strikethrough~~, [text](url). Inline formats only —
 * block syntax (headings/lists etc.) is treated as plain text; all literal text goes
 * through React escaping, so there's no XSS surface.
 * Links uniformly preventDefault (in Electron the default navigation would take over
 * the whole app window; the main process has no openExternal channel yet), with the
 * URL visible in the title.
 */
import type { ReactNode } from 'react';

const TOKEN_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(\[[^\]\n]*\]\([^)\s]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index!;
    if (idx > last) nodes.push(text.slice(last, idx));
    const raw = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (raw.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded bg-fill px-1 py-0.5 font-mono text-[0.85em]">
          {raw.slice(1, -1)}
        </code>,
      );
    } else if (raw.startsWith('**')) {
      nodes.push(<strong key={key}>{renderInline(raw.slice(2, -2), key)}</strong>);
    } else if (raw.startsWith('~~')) {
      nodes.push(<del key={key}>{renderInline(raw.slice(2, -2), key)}</del>);
    } else if (raw.startsWith('*')) {
      nodes.push(<em key={key}>{renderInline(raw.slice(1, -1), key)}</em>);
    } else {
      const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(raw)!;
      nodes.push(
        <a
          key={key}
          href={link[2]}
          title={link[2]}
          className="text-accent hover:underline"
          onClick={(e) => e.preventDefault()}
        >
          {renderInline(link[1], key)}
        </a>,
      );
    }
    last = idx + raw.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function InlineMd({ text }: { text: string }) {
  return <>{renderInline(text, 'md')}</>;
}
