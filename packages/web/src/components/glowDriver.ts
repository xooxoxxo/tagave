/**
 * The equalizer glow's levels across the bottom of the window: one rAF loop
 * for every piece of the glow (the player bar, the sidebar's account row
 * beside it, the phone's mini bar), so the columns of one piece carry on in
 * the next. It reads the three bands of adaptive/levels.ts, compresses them
 * (a loud master and a quiet one both move it, no band spikes alone) and
 * smooths them over time (up quickly, down slowly), at most 30 times a
 * second, then spreads them
 * across the width: the lows in the middle, the highs at the ends, the
 * middle evened out towards the mean, and a slow ripple so neighbouring
 * columns differ. Each piece maps its own columns onto this.
 */
import { BANDS, bandReader } from '../adaptive/levels';

/** Levels across the whole width, left to right. */
export const SPAN = 64;

/** The width's envelope: fullest in the middle, short and faint towards both ends. */
export const envelope = (x: number) => 0.15 + 0.85 * Math.sin(Math.PI * Math.min(1, Math.max(0, x))) ** 0.8;

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
/** Smooth value noise, 0 to 1. */
function noise(x: number): number {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

/** Compressed bands to levels across the width (pure: tests and stills). */
export function spread(bands: ArrayLike<number>, t: number, out = new Float32Array(SPAN)): Float32Array {
  const [low = 0, mid = 0, high = 0] = Array.from(bands);
  const mean = (low + mid + high) / 3;
  for (let k = 0; k < SPAN; k++) {
    const d = Math.abs(k / (SPAN - 1) - 0.5) * 2;
    const mapped = d < 0.5 ? low + (mid - low) * d * 2 : mid + (high - mid) * (d - 0.5) * 2;
    // the middle evens out towards the mean: no single band spikes there
    const even = mapped + (mean - mapped) * 0.7 * (1 - d);
    const ripple = 0.85 + 0.15 * noise(t * 2.2 + k * 1.37);
    out[k] = Math.min(1, Math.max(0, even * ripple));
  }
  return out;
}

/** A band, compressed: quiet passages still lift it, loud ones never pin it. */
export const compress = (v: number) => 0.18 + 0.72 * Math.min(1, Math.max(0, v)) ** 0.6;

type Listener = (levels: Float32Array) => void;
const listeners = new Set<Listener>();
let read: ((out: Float32Array) => void) | null = null;
let readFor: AnalyserNode | null = null;
let raf = 0;
let last = 0;
/** Frames a second at most: the levels are smoothed, more would only cost style work on every column. */
const FPS = 30;
const raw = new Float32Array(BANDS);
const smooth = new Float32Array(BANDS);
const levels = new Float32Array(SPAN);

/** The levels' source: the player's analyser (one reader for every piece), or a function (stories). */
export function setSource(source: AnalyserNode | ((out: Float32Array) => void)): void {
  if (typeof source === 'function') { read = source; readFor = null; return; }
  if (readFor === source) return;
  readFor = source;
  read = bandReader(source);
}

function frame(now: number) {
  raf = requestAnimationFrame(frame);
  if (now - last < 1000 / FPS - 2) return;
  last = now;
  read?.(raw);
  for (let b = 0; b < BANDS; b++) {
    const c = compress(raw[b]!);
    smooth[b]! += (c - smooth[b]!) * (c > smooth[b]! ? 0.5 : 0.11);
  }
  spread(smooth, now / 1000, levels);
  for (const l of listeners) l(levels);
}

/** Levels every frame while subscribed; the loop runs only while someone listens. */
export function subscribe(l: Listener): () => void {
  listeners.add(l);
  if (listeners.size === 1) raf = requestAnimationFrame(frame);
  return () => {
    listeners.delete(l);
    if (!listeners.size) cancelAnimationFrame(raf);
  };
}
