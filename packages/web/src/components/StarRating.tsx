/**
 * Half-star rating control (spec REV-3: 0.5–5.0 in half-star steps).
 * Without onChange it is a read-only display.
 *
 * Two ways to pick, chosen by the pointer:
 * - mouse / trackpad (fine pointer): each star has a left and a right half
 *   (x.5 and x.0); clicking the current value clears it.
 * - touch (coarse pointer): each star is ONE 44×44 target; tapping a star
 *   gives that many stars, tapping it again toggles the half star (4 → 3.5
 *   → 4). Clearing is the visible "Clear" next to the stars.
 *
 * The hover preview only follows a real mouse (a tap fires mouseenter on iOS
 * and never blurs, which used to leave a stale preview behind), it clears on
 * click, and it is drawn in a lighter tint than the saved value so the
 * committed rating always reads clearly.
 */
import { useEffect, useState, type CSSProperties, type FocusEvent, type PointerEvent } from 'react';
import styles from './StarRating.module.css';

interface StarRatingProps {
  value: number | null | undefined;
  onChange?: (value: number | null) => void;
  size?: number;
  showValue?: boolean;
}

export const STAR_TARGET = 44;

/** Gap between stars and the reach of each target above/below the glyph, so a star is a full 44px target. */
export function starHitGeometry(size: number, interactive: boolean): { gap: number; reach: number } {
  if (!interactive) return { gap: 2, reach: 0 };
  return { gap: Math.max(2, STAR_TARGET - size), reach: Math.max(0, (STAR_TARGET - size) / 2) };
}

/**
 * The rating after a pick. Fine pointer: `tapped` is the half value picked,
 * and picking the current value clears. Coarse pointer: `tapped` is the whole
 * star; tapping the current star toggles its half.
 */
export function nextRating(current: number | null, tapped: number, coarse: boolean): number | null {
  if (!coarse) return current === tapped ? null : tapped;
  if (current === tapped) return tapped - 0.5;
  if (current === tapped - 0.5) return tapped;
  return tapped;
}

const COARSE_QUERY = '(pointer: coarse)';

function matchCoarse(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches;
  } catch {
    return false;
  }
}

/** True on a touch-first device (phone, tablet). Follows changes (e.g. a tablet docked to a keyboard). */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(matchCoarse);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(COARSE_QUERY);
    const on = () => setCoarse(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return coarse;
}

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

export function StarRating({ value, onChange, size = 22, showValue }: StarRatingProps) {
  const [hover, setHover] = useState<number | null>(null);
  const coarse = useCoarsePointer();
  const current = value ?? null;
  const shown = hover ?? current ?? 0;
  const readOnly = !onChange;
  const { gap, reach } = starHitGeometry(size, !readOnly);

  const pick = (v: number) => {
    setHover(null);
    onChange?.(nextRating(current, v, coarse));
  };
  const previewProps = (v: number) => ({
    onPointerEnter: (e: PointerEvent) => { if (e.pointerType === 'mouse') setHover(v); },
    // keyboard focus previews too; a tap that happens to focus the button does not
    onFocus: (e: FocusEvent<HTMLButtonElement>) => { if (isFocusVisible(e.currentTarget)) setHover(v); },
    onBlur: () => setHover(null),
    onClick: () => pick(v),
  });

  const half = (v: number, left: string) => (
    <button
      type="button"
      className={styles.half}
      style={{ left, top: -reach, bottom: -reach, width: `calc(50% + ${gap / 2}px)`, marginLeft: left === '0' ? -gap / 2 : 0 } as CSSProperties}
      aria-label={`Rate ${v} of 5`}
      aria-pressed={current === v}
      {...previewProps(v)}
    />
  );
  const whole = (i: number) => (
    <button
      type="button"
      className={styles.half}
      style={{ left: -gap / 2, right: -gap / 2, top: -reach, bottom: -reach } as CSSProperties}
      aria-label={current === i ? `Rate ${i - 0.5} of 5` : `Rate ${i} of 5`}
      aria-pressed={current === i || current === i - 0.5}
      data-target="whole"
      {...previewProps(i)}
    />
  );

  return (
    <span
      className={[
        styles.stars,
        readOnly ? undefined : styles.interactive,
        current != null ? styles.rated : undefined,
        hover != null ? styles.previewing : undefined,
      ].filter(Boolean).join(' ')}
      style={{ gap }}
      role={readOnly ? 'img' : 'group'}
      aria-label={current ? `${current} of 5 stars` : 'Not rated'}
      onPointerLeave={() => setHover(null)}
    >
      {[1, 2, 3, 4, 5].map((i) => {
        const fill = Math.max(0, Math.min(1, shown - (i - 1)));
        return (
          <span key={i} className={styles.star} style={{ width: size, height: size, fontSize: size }}>
            <span className={styles.starEmpty} aria-hidden="true">★</span>
            <span className={styles.starFill} style={{ width: `${fill * 100}%` }} aria-hidden="true">★</span>
            {!readOnly && (coarse ? whole(i) : (
              <>
                {half(i - 0.5, '0')}
                {half(i, '50%')}
              </>
            ))}
          </span>
        );
      })}
      {showValue && (
        <span className={styles.value}>{(hover ?? current) != null ? (hover ?? current)!.toFixed(1) : '–'}</span>
      )}
    </span>
  );
}
