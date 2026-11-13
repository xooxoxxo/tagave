/**
 * A knob: a still ring and a notch that turns (transform only), its name
 * and value under it. A slider to assistive technology (role slider, its
 * name, its value as text). Drag up or right to turn it up; arrow keys step,
 * Page Up / Page Down step ten times as far, Home and End go to the ends;
 * a double click, Delete or Backspace put it back where it rests. The DJ
 * view's effects use it (components/dj/Deck.tsx).
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import styles from './Knob.module.css';

export interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** values snap to this (default: a hundredth of the range) */
  step?: number;
  /** where it rests: double click and Delete go back here; away from it the notch takes the accent */
  defaultValue?: number;
  /** the value as shown and read out */
  format?: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** the visible name (default: the label); the accessible name stays the label */
  caption?: string;
  className?: string;
}

/** The notch turns through 270°, from −135° at the bottom left. */
export const KNOB_SWEEP = 270;

export function knobAngle(value: number, min: number, max: number): number {
  const x = max > min ? (Math.min(max, Math.max(min, value)) - min) / (max - min) : 0;
  return -KNOB_SWEEP / 2 + x * KNOB_SWEEP;
}

export function snapValue(v: number, min: number, max: number, step: number): number {
  const s = step > 0 ? Math.round((v - min) / step) * step + min : v;
  return Math.min(max, Math.max(min, Math.round(s * 1e6) / 1e6));
}

/**
 * Where a key takes a knob or a fader: arrows a fiftieth of the range (at
 * least a step), Page Up / Down ten times that, Home / End the ends, Delete
 * and Backspace where it rests. Null: not its key.
 */
export function keyValue(key: string, k: { value: number; min: number; max: number; unit: number; rest: number }): number | null {
  const small = Math.max(k.unit, (k.max - k.min) / 50);
  const steps: Record<string, number> = { ArrowUp: small, ArrowRight: small, ArrowDown: -small, ArrowLeft: -small, PageUp: small * 10, PageDown: -small * 10 };
  if (key in steps) return k.value + steps[key]!;
  if (key === 'Home') return k.min;
  if (key === 'End') return k.max;
  if (key === 'Delete' || key === 'Backspace') return k.rest;
  return null;
}

/** Pixels of drag for the whole range. */
const DRAG_RANGE_PX = 160;

export function Knob({ label, value, min, max, step, defaultValue, format, onChange, disabled = false, caption, className }: KnobProps) {
  const unit = step ?? (max - min) / 100;
  const rest = defaultValue ?? min;
  const drag = useRef<{ x: number; y: number; v: number } | null>(null);
  const text = format ? format(value) : String(value);
  const set = (v: number) => {
    const next = snapValue(v, min, max, unit);
    if (next !== value) onChange(next);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    drag.current = { x: e.clientX, y: e.clientY, v: value };
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const moved = (d.y - e.clientY + (e.clientX - d.x)) / DRAG_RANGE_PX;
    set(d.v + moved * (max - min));
  };
  const end = () => { drag.current = null; };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = keyValue(e.key, { value, min, max, unit, rest });
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    set(next);
  };
  const away = Math.abs(value - rest) > unit / 2;
  return (
    <div className={[styles.knob, className].filter(Boolean).join(' ')} data-away={away ? '' : undefined} data-disabled={disabled ? '' : undefined}>
      <div
        className={styles.dial}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={() => { if (!disabled) set(rest); }}
        onKeyDown={onKeyDown}
      >
        <span className={styles.notch} style={{ transform: `rotate(${knobAngle(value, min, max)}deg)` }} aria-hidden="true" />
      </div>
      <span className={styles.caption} aria-hidden="true">{caption ?? label}</span>
      <span className={styles.value} aria-hidden="true">{text}</span>
    </div>
  );
}
