/**
 * Half-star rating control (spec REV-3: 0.5–5.0 in half-star steps).
 * Without onChange it is a read-only display. Clicking the current value
 * clears the rating.
 */
import { useState } from 'react';
import styles from './StarRating.module.css';

interface StarRatingProps {
  value: number | null | undefined;
  onChange?: (value: number | null) => void;
  size?: number;
  showValue?: boolean;
}

export function StarRating({ value, onChange, size = 22, showValue }: StarRatingProps) {
  const [hover, setHover] = useState<number | null>(null);
  const current = value ?? null;
  const shown = hover ?? current ?? 0;
  const readOnly = !onChange;

  const pick = (v: number) => onChange?.(current === v ? null : v);

  return (
    <span
      className={styles.stars}
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
                <button
                  type="button"
                  className={styles.half}
                  style={{ left: 0 }}
                  aria-label={`Rate ${i - 0.5}`}
                  onMouseEnter={() => setHover(i - 0.5)}
                  onFocus={() => setHover(i - 0.5)}
                  onBlur={() => setHover(null)}
                  onClick={() => pick(i - 0.5)}
                />
                <button
                  type="button"
                  className={styles.half}
                  style={{ left: '50%' }}
                  aria-label={`Rate ${i}`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  onClick={() => pick(i)}
                />
              </>
            )}
          </span>
        );
      })}
      {(showValue || !readOnly) && (
        <span className={styles.value}>{(hover ?? current) != null ? (hover ?? current)!.toFixed(1) : '–'}</span>
      )}
    </span>
  );
}
