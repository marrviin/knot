/**
 * Marquee for list item names (aligned with manta-compare's MarqueeLabel):
 * single line with ellipsis by default; on hover, if the text overflows, it loops
 * leftward to reveal the full content. On mount/content change, the overflow distance
 * is measured and written into a CSS variable driving the animation; no scrolling
 * when there's no overflow. Scroll speed derives from the overflow distance, keeping a
 * constant cadence for long and short names alike (a pause frame at each end).
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import cx from 'classnames';

export function MarqueeLabel({ text, className }: { text: ReactNode; className?: string }) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  // Measure overflow: inner is block+nowrap so scrollWidth is the full text width; the
  // difference from the visible width is the leftward scroll distance. Fonts/layout may
  // not be stable at mount, so the first measurement can undershoot — re-measure on
  // mouse enter for an accurate value.
  const measure = () => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return;
    const overflow = inner.scrollWidth - wrap.clientWidth;
    setShift(overflow > 0 ? overflow : 0);
  };

  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [text]);

  useLayoutEffect(() => {
    // After async font loading, text width changes but the container size doesn't, so
    // ResizeObserver won't fire — re-measure proactively.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts?.ready) return;
    let alive = true;
    fonts.ready.then(() => {
      if (alive) measure();
    });
    return () => {
      alive = false;
    };
  }, [text]);

  // Constant 160px/s speed, same cadence for long and short names (pause frames defined in components.css's keyframe).
  const duration = shift > 0 ? Math.max(1.5, shift / 160 + 0.4) : 0;
  return (
    <span
      ref={wrapRef}
      className={cx('pc-marquee', className)}
      onMouseEnter={measure}
      style={
        {
          '--marquee-shift': `-${shift}px`,
          '--marquee-duration': `${duration}s`,
        } as CSSProperties
      }
    >
      <span ref={innerRef} className="pc-marquee__inner">
        {text}
      </span>
    </span>
  );
}
