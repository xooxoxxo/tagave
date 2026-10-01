/**
 * Half-star rating control (spec REV-3: 0.5–5.0 in half-star steps).
 * Without onChange it is a read-only display. Clicking the current value
 * clears the rating.
 *
 * Interactive stars are spaced so each one is a 44px target (the left and
 * right halves pick x.5 and x.0), the halves reach above and below the glyph
 * to the same 44px, and the chosen value shows as filled stars plus a
 * pressed state on its half.
 */
import { useState, type CSSProperties } from 'react';
import styles from './StarRating.module.css';

interface StarRatingProps {
  value: number | null | undefined;
  onChange?: (value: number | null) => void;
  size?: number;
  showValue?: boolean;
}

export const STAR_TARGET = 44;

/** Gap between stars and the reach of each half above/below the glyph, so a star is a full target. */
export function starHitGeometry(size: number, interactive: boolean): { gap: number; reach: number } {
  if (!interactive) return { gap: 2, reach: 0 };
  return { gap: Math.max(2, STAR_TARGET - size), reach: Math.max(0, (STAR_TARGET - size) / 2) };
}

export function StarRating({ value, onChange, size = 22, showValue }: StarRatingProps) {
  const [hover, setHover] = useState<number | null>(null);
  const current = value ?? null;
  const shown = hover ?? current ?? 0;
  const readOnly = !onChange;
  const { gap, reach } = starHitGeometry(size, !readOnly);

  const pick = (v: number) => onChange?.(current === v ? null : v);
  const half = (v: number, left: string) => (
    <button
      type="button"
      className={styles.half}
      style={{ left, top: -reach, bottom: -reach, width: `calc(50% + ${gap / 2}px)`, marginLeft: left === '0' ? -gap / 2 : 0 } as CSSProperties}
      aria-label={`Rate ${v} of 5`}
      aria-pressed={current === v}
      onMouseEnter={() => setHover(v)}
      onFocus={() => setHover(v)}
      onBlur={() => setHover(null)}
      onClick={() => pick(v)}
    />
  );

  return (
    <span
      className={[styles.stars, readOnly ? undefined : styles.interactive, current != null ? styles.rated : undefined].filter(Boolean).join(' ')}
      style={{ gap }}
      role={readOnly ? 'img' : 'group'}
      aria-label={current ? `${current} of 5 stars` : 'Not rated'}
      onMouseLeave={() => setHover(null)}
    >
      {[1, 2, 3, 4, 5].map((i) => {
        const fill = Math.max(0, Math.min(1, shown - (i - 1)));
        return (
          <span key={i} className={styles.star} style={{ width: size, height: size, fontSize: size }}>
            <span className={styles.starEmpty} aria-hidden="true">★</span>
            <span className={styles.starFill} style={{ width: `${fill * 100}%` }} aria-hidden="true">★</span>
            {!readOnly && (
              <>
                {half(i - 0.5, '0')}
                {half(i, '50%')}
              </>
            )}
          </span>
        );
      })}
      {showValue && (
        <span className={styles.value}>{(hover ?? current) != null ? (hover ?? current)!.toFixed(1) : '–'}</span>
      )}
    </span>
  );
}
