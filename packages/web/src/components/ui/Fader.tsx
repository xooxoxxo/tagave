/**
 * A fader: a horizontal slider whose fill and thumb move by transform. A
 * slider to assistive technology (role slider, its name, its value as
 * text). Press or drag along it; arrow keys step, Page Up / Page Down step
 * ten times as far, Home and End go to the ends; a double click, Delete or
 * Backspace put it back where it rests. `centred` fills from the middle
 * (Pitch). The DJ view's Pitch and crossfader use it.
 */
import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { keyValue, snapValue } from './Knob';
import styles from './Fader.module.css';

export interface FaderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** where it rests (double click, Delete); default: min, or the middle when centred */
  defaultValue?: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  /** the fill starts at the middle */
  centred?: boolean;
  disabled?: boolean;
  className?: string;
  /** shown at the ends (the crossfader's A and B) */
  start?: ReactNode;
  end?: ReactNode;
}

/** The fill's transform: from the left (scaleX), or from the middle out to the value. */
export function faderFill(fraction: number, centred: boolean): string {
  const p = Math.min(1, Math.max(0, fraction));
  if (!centred) return `scaleX(${p})`;
  return `translateX(${Math.min(p, 0.5) * 100}%) scaleX(${Math.abs(p - 0.5)})`;
}

export function Fader({ label, value, min, max, step, defaultValue, format, onChange, centred = false, disabled = false, className, start, end }: FaderProps) {
  const unit = step ?? (max - min) / 100;
  const rest = defaultValue ?? (centred ? (min + max) / 2 : min);
  const railRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const fraction = max > min ? (Math.min(max, Math.max(min, value)) - min) / (max - min) : 0;
  const text = format ? format(value) : String(value);
  const set = (v: number) => {
    const next = snapValue(v, min, max, unit);
    if (next !== value) onChange(next);
  };
  const at = (clientX: number) => {
    const r = railRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return value;
    return min + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * (max - min);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    dragging.current = true;
    set(at(e.clientX));
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => { if (dragging.current) set(at(e.clientX)); };
  const stop = () => { dragging.current = false; };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = keyValue(e.key, { value, min, max, unit, rest });
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    set(next);
  };
  return (
    <div className={[styles.wrap, className].filter(Boolean).join(' ')} data-disabled={disabled ? '' : undefined}>
      {start != null && <span className={styles.end} aria-hidden="true">{start}</span>}
      <div
        className={styles.fader}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
        aria-disabled={disabled || undefined}
        aria-orientation="horizontal"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stop}
        onPointerCancel={stop}
        onLostPointerCapture={stop}
        onDoubleClick={() => { if (!disabled) set(rest); }}
        onKeyDown={onKeyDown}
      >
        <div ref={railRef} className={styles.rail}>
          <span className={styles.fill} style={{ transform: faderFill(fraction, centred) }} />
        </div>
        {centred && <span className={styles.tick} aria-hidden="true" />}
        <span className={styles.runway} aria-hidden="true">
          <span className={styles.runner} style={{ transform: `translateX(${fraction * 100}%)` }}>
            <span className={styles.thumb} />
          </span>
        </span>
      </div>
      {end != null && <span className={styles.end} aria-hidden="true">{end}</span>}
    </div>
  );
}
