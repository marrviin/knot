/**
 * Inline markdown rendering (dependency-free, hand-written tokenizer): supports
 * `code`, **bold**, *italic*, ~~strikethrough~~, [text](url). Inline formats only —
 * block syntax (headings/lists etc.) is treated as plain text; all literal text goes
 * through React escaping, so there's no XSS surface.
 * Links preventDefault (in Electron the default navigation would take over the whole
 * app window) and open in the system browser via the main process's open_external
 * channel (https-only); the URL stays visible in the title.
 *
 * `hand` variant (journal only): renders ~~del~~ / **strong** as handwriting marks
 * (red-pen strike, hand-drawn underline — both per-line background textures) and
 * additionally recognizes ==text== as a hand-drawn circle (SVG overlay). Default
 * rendering is untouched — app.tsx callers see the same output as before.
 */
import { App as AntdApp } from 'antd';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as api from './api';

const TOKEN_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(\[[^\]\n]*\]\([^)\s]+\))/g;

// ==circle== and ^inserted^ are journal-only syntax — keep them out of the
// default tokenizer (== appears in plain text like "a == b" elsewhere; ^ in math).
const HAND_TOKEN_RE =
  /(`[^`\n]+`)|(==[^=\n]+==)|(\^[^^\n]+\^)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(\[[^\]\n]*\]\([^)\s]+\))/g;

// ---------- hand-drawn SVG marks (deterministic, zero-dependency) ----------

/** FNV-1a → stable seed: the same text always draws the same wobble, so
 *  re-renders don't make the ink jump around. */
function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic 0..1 pseudo-random from a seed + tap. */
function jitter(seed: number, tap: number): number {
  let x = (seed + tap * 2654435761) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 2246822519);
  x = Math.imul(x ^ (x >>> 13), 3266489917);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** A hand-drawn ellipse in px space around the measured glyph box: two slightly
 *  different loops (real people go around twice), ends overshooting a touch. */
function circlePaths(
  seed: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): [string, string] {
  const f = (n: number) => n.toFixed(1);
  const tilt = (jitter(seed, 2) - 0.5) * rx * 0.12;
  const loop = (k: number, dy: number) => {
    const rxx = rx * k;
    const ryy = ry * k;
    const x1 = f(cx - rxx - 3);
    const x2 = f(cx + rxx + 3);
    return (
      `M ${x1} ${f(cy + dy + tilt)}` +
      ` C ${f(cx - rxx)} ${f(cy + dy - ryy + tilt)}, ${f(cx + rxx)} ${f(cy + dy - ryy - tilt)}, ${x2} ${f(cy + dy - tilt)}` +
      ` C ${f(cx + rxx)} ${f(cy + dy + ryy - tilt)}, ${f(cx - rxx)} ${f(cy + dy + ryy + tilt)}, ${x1} ${f(cy + dy + tilt)}`
    );
  };
  return [loop(1, 0), loop(0.94, 1.2)];
}

/** Only the circle uses an SVG overlay: strike/underline are per-line background
 *  textures (css repeat-x + box-decoration-break) so wrapped lines each get their
 *  own stroke — an overlay across a wrapped inline span would draw one diagonal
 *  line over the union box (rough-notation solves the same problem by rendering
 *  per getClientRects() line rect; the background trick is its zero-JS form).
 *
 *  The circle draws from a MEASURED glyph box (DOM Range) rather than the span's
 *  content box: handwriting-font metrics make the inline box unreliable, and the
 *  measured rect hugs the real glyphs so the ellipse fits the word. Re-measures
 *  on resize and after the webfont chunks swap in. */
function HandCircle({ seed, children }: { seed: number; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [geo, setGeo] = useState<{
    hostW: number;
    hostH: number;
    cx: number;
    cy: number;
    rx: number;
    ry: number;
  } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      if (!rects.length) return;
      // nowrap keeps this single-line; take the union anyway for safety
      const left = Math.min(...rects.map((r) => r.left));
      const top = Math.min(...rects.map((r) => r.top));
      const right = Math.max(...rects.map((r) => r.right));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      const host = el.getBoundingClientRect();
      const w = right - left;
      const h = bottom - top;
      // +px margins keep the ink off the glyphs (the measured rect hugs them)
      setGeo({
        hostW: host.width,
        hostH: host.height,
        cx: left - host.left + w / 2,
        cy: top - host.top + h / 2,
        rx: w / 2 + 4,
        ry: h / 2 + 3,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => ro.disconnect();
  }, []);

  const [d1, d2] = geo
    ? circlePaths(seed, geo.cx, geo.cy, geo.rx, geo.ry)
    : [null, null];
  return (
    <span ref={ref} className="jnl-circle">
      {children}
      {geo && (
        <svg
          className="jnl-mark"
          viewBox={`0 0 ${geo.hostW} ${geo.hostH}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d={d1!} fill="none" stroke="var(--jnl-red)" strokeWidth={1.6} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={d2!} fill="none" stroke="var(--jnl-red)" strokeWidth={1.2} strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity={0.55} />
        </svg>
      )}
    </span>
  );
}

function renderInline(
  text: string,
  keyPrefix: string,
  openExternal: (url: string) => void,
  hand = false,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(hand ? HAND_TOKEN_RE : TOKEN_RE)) {
    const idx = m.index!;
    if (idx > last) nodes.push(text.slice(last, idx));
    const raw = m[0];
    const key = `${keyPrefix}-${i++}`;
    const inner = (s: string) => renderInline(s, key, openExternal, hand);
    if (raw.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded bg-fill px-1 py-0.5 font-mono text-[0.85em]">
          {raw.slice(1, -1)}
        </code>,
      );
    } else if (raw.startsWith('^')) {
      // 校对插入符：漏写的词补在行外（小字上浮），下方一个 ^ 指向落笔处
      nodes.push(
        <span key={key} className="jnl-insert">
          <svg className="jnl-caret" viewBox="0 0 10 6" aria-hidden="true">
            <path
              d="M1 5 L5 1 L9 5"
              fill="none"
              stroke="var(--jnl-pen)"
              strokeWidth={1.4}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {inner(raw.slice(1, -1))}
        </span>,
      );
    } else if (raw.startsWith('==')) {
      nodes.push(
        <HandCircle key={key} seed={seedOf(raw)}>
          {inner(raw.slice(2, -2))}
        </HandCircle>,
      );
    } else if (raw.startsWith('**')) {
      const body = inner(raw.slice(2, -2));
      nodes.push(
        <strong key={key} className={hand ? 'jnl-underline' : undefined}>
          {body}
        </strong>,
      );
    } else if (raw.startsWith('~~')) {
      const body = inner(raw.slice(2, -2));
      nodes.push(
        // 涂改：红笔划掉，字仍可读（划掉的是写错的词）。
        // 划线是逐行背景纹理（.jnl-del），换行不会连成一条斜线。
        <del key={key} className={hand ? 'jnl-del' : undefined}>
          {body}
        </del>,
      );
    } else if (raw.startsWith('*')) {
      nodes.push(<em key={key}>{inner(raw.slice(1, -1))}</em>);
    } else {
      const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(raw)!;
      nodes.push(
        <a
          key={key}
          href={link[2]}
          title={link[2]}
          className="text-accent hover:underline"
          onClick={(e) => {
            e.preventDefault();
            openExternal(link[2]);
          }}
        >
          {renderInline(link[1], key, openExternal, hand)}
        </a>,
      );
    }
    last = idx + raw.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function InlineMd({ text, hand = false }: { text: string; hand?: boolean }) {
  const { message } = AntdApp.useApp();
  const openExternal = (url: string) => {
    api.openExternal(url).catch((e: any) => {
      message.error(`无法打开链接: ${e?.message ?? e}`);
    });
  };
  return <>{renderInline(text, 'md', openExternal, hand)}</>;
}
