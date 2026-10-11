/**
 * Agent icons: agents with real brand marks (claude-code / joycode / codex / hermes) render
 * the official icons bundled into the project (src/assets/agents/); the rest
 * (myagent / user, plus names typed into custom watch cards) fall back to
 * a rounded square in an approximate brand color + first character. Pure display
 * component, shared by watch cards and memory card metadata.
 *
 * Sources: claude-code.svg and codex.svg are from simple-icons (CC0; codex uses the
 * OpenAI mark, tinted with the brand teal); joycode.png is the official favicon
 * from joycode.jd.com; hermes.svg is the official icon-master.svg from
 * github.com/NousResearch/hermes-agent (assets/, white tile + nous-girl mark).
 */
import claudeSvg from './assets/agents/claude-code.svg';
import codexSvg from './assets/agents/codex.svg';
import hermesSvg from './assets/agents/hermes.svg';
import joycodePng from './assets/agents/joycode.png';

const AGENT_ICONS: Record<string, { src?: string; color: string; glyph: string }> = {
  'claude-code': { src: claudeSvg, color: '#d97757', glyph: '✳' },
  joycode: { src: joycodePng, color: '#e1251b', glyph: 'J' },
  codex: { src: codexSvg, color: '#10a37f', glyph: 'C' },
  hermes: { src: hermesSvg, color: '#8b5cf6', glyph: 'H' }, // purple (fallback only; src overrides)
  myagent: { color: '#3768fa', glyph: '自' }, // Knot primary blue
  user: { color: '#8e8e93', glyph: '人' }, // neutral gray
};

const FALLBACK_COLOR = '#8e8e93';

export function AgentIcon({ agent, size = 20 }: { agent: string; size?: number }) {
  const icon = AGENT_ICONS[agent];

  // Has an official mark: render the icon file directly (svg carries brand color / png is the official rounded tile).
  if (icon?.src) {
    return (
      <img
        src={icon.src}
        alt=""
        aria-hidden
        draggable={false}
        className="shrink-0 object-contain select-none"
        style={{ width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.18)) }}
      />
    );
  }

  // Fallback: small rounded square + first character in an approximate brand color.
  const glyph = (icon?.glyph ?? agent[0] ?? '?').toUpperCase();
  const color = icon?.color ?? FALLBACK_COLOR;
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-md font-semibold leading-none select-none"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
    >
      {glyph}
    </span>
  );
}
