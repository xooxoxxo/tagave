/**
 * The aurora's motion, one loop for every piece of it (the player bar, the
 * sidebar's account row beside it, the phone's mini bar), so its curtains
 * carry on from one piece to the next. It reads the bands of
 * adaptive/levels.ts and turns them into a slow, calm state: an overall
 * level (the mean, the bass weighing more) that rises over a second and
 * falls over a few, so the aurora breathes with the music and never jumps.
 * From it: how bright the curtains are, how high they reach, and how fast
 * they drift sideways (each curtain at its own pace and direction, folding
 * through the others). At most 30 frames a second; only transforms and
 * opacity are written.
 */
import { BANDS, bandReader } from '../adaptive/levels';

/** The curtains: how fast each drifts (widths of the window per second, signed) and how high it reaches. */
export const CURTAINS = [
  { drift: 0.011, reach: 1 },
  { drift: -0.007, reach: 0.82 },
  { drift: 0.016, reach: 0.66 },
] as const;

export interface AuroraState {
  /** each curtain's place, 0 to 1 of the window's width */
  phase: number[];
  /** each curtain's lean (deg), a slow fold */
  lean: number[];
  /** 0 to 1: how loud, slowly */
  level: number;
}

/** A curtain's height (scaleY) and brightness (opacity) at a level. */
export const curtainOf = (reach: number, level: number) => ({ height: reach * (0.5 + 0.5 * level), bright: 0.62 + 0.38 * level });

/** The calm state one step on: the level eases toward the music, the curtains drift with it (pure: tests). */
export function step(s: AuroraState, bands: ArrayLike<number>, dt: number, t: number): AuroraState {
  const [low = 0, mid = 0, high = 0] = Array.from(bands);
  const target = Math.min(1, low * 0.5 + mid * 0.3 + high * 0.2);
  // up over about a second, down over about three: it breathes, it never jumps
  const k = target > s.level ? 1 - Math.exp(-dt / 0.9) : 1 - Math.exp(-dt / 2.8);
  const level = s.level + (target - s.level) * k;
  return {
    level,
    phase: CURTAINS.map((c, i) => (((s.phase[i] ?? 0) + c.drift * (1 + 1.4 * level) * dt) % 1 + 1) % 1),
    lean: CURTAINS.map((_, i) => 5 * Math.sin(t * (0.09 + 0.04 * i) + i * 2.1)),
  };
}

type Listener = (s: AuroraState) => void;
const listeners = new Set<Listener>();
let read: ((out: Float32Array) => void) | null = null;
let readFor: AnalyserNode | null = null;
let raf = 0;
let last = 0;
const FPS = 30;
const bands = new Float32Array(BANDS);
let state: AuroraState = { phase: CURTAINS.map((_, i) => i * 0.31), lean: CURTAINS.map(() => 0), level: 0.3 };

/** Where the curtains are now (a piece that mounts later starts from here). */
export const auroraNow = (): AuroraState => state;

/** The levels' source: the player's analyser (one reader for every piece), or a function (stories). */
export function setSource(source: AnalyserNode | ((out: Float32Array) => void)): void {
  if (typeof source === 'function') { read = source; readFor = null; return; }
  if (readFor === source) return;
  readFor = source;
  read = bandReader(source);
}

function frame(now: number) {
  raf = requestAnimationFrame(frame);
  if (last && now - last < 1000 / FPS - 2) return;
  const dt = last ? Math.min(0.2, (now - last) / 1000) : 1 / FPS;
  last = now;
  read?.(bands);
  state = step(state, bands, dt, now / 1000);
  for (const l of listeners) l(state);
}

/** The state every frame while subscribed; the loop runs only while someone listens. */
export function subscribe(l: Listener): () => void {
  listeners.add(l);
  if (listeners.size === 1) { last = 0; raf = requestAnimationFrame(frame); }
  return () => {
    listeners.delete(l);
    if (!listeners.size) cancelAnimationFrame(raf);
  };
}
