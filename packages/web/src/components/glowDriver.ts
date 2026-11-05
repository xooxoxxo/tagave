/**
 * The equalizer glow's motion and drawing (BarGlow.tsx): the bands of
 * adaptive/levels.ts become one soft wash of light rising from the player
 * bar's top edge, never separate bars. Each band is a point along the bar,
 * mirrored about one spot (the bass there, the treble out toward both ends;
 * on a desktop that spot sits on the bar's right side, on a phone the mini
 * bar's middle), and the light's height between them is a wide, smooth
 * blend of their levels: hills that swell with the music and melt into one
 * another. The points drift slowly and a faint brightness travels along the
 * edge, so the light flows even on a held note.
 *
 * Every band has a quick attack and a slower release, so a beat reads at
 * once and the light settles rather than flickers. The line along the edge
 * follows the overall loudness. Pure functions here (tests); BarGlow runs
 * the one loop.
 */
import { BANDS } from '../adaptive/levels';

/** Time constants (s): a band rises within about 80 ms and falls over about 500. */
export const ATTACK = 0.04;
export const RELEASE = 0.22;
/** The line's loudness: a touch slower both ways than a band. */
const LOUD_ATTACK = 0.05;
const LOUD_RELEASE = 0.26;

/** Where the mirror point sits, as a share of the bar's width. */
export const ANCHOR = { right: 0.72, centre: 0.5 } as const;
export type Anchor = keyof typeof ANCHOR;

export interface Spectrum {
  /** each band's level, 0 to 1 */
  level: Float32Array;
  /** the line: overall loudness, 0 to 1 */
  loud: number;
  /** the light's own clock (s): the drift; still while nothing plays */
  t: number;
}

export const emptySpectrum = (bands = BANDS): Spectrum => ({ level: new Float32Array(bands), loud: 0, t: 0 });

const approach = (cur: number, target: number, dt: number, up: number, down: number) =>
  cur + (target - cur) * (1 - Math.exp(-dt / (target > cur ? up : down)));

/** How loud, from the bands: their mean, the lower half weighing more (kick, bass and voice carry a song). */
export function loudnessOf(raw: ArrayLike<number>): number {
  let sum = 0, weight = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = i < raw.length / 2 ? 1.5 : 1;
    sum += (raw[i] ?? 0) * w;
    weight += w;
  }
  return weight ? Math.min(1, (sum / weight) * 1.5) : 0;
}

/** The spectrum one frame on, toward the raw bands (in place: no garbage at 30 frames a second). */
export function stepSpectrum(s: Spectrum, raw: ArrayLike<number>, dt: number): Spectrum {
  for (let i = 0; i < s.level.length; i++) {
    const v = Math.min(1, Math.max(0, raw[i] ?? 0));
    s.level[i] = approach(s.level[i]!, v, dt, ATTACK, RELEASE);
  }
  s.loud = approach(s.loud, loudnessOf(raw), dt, LOUD_ATTACK, LOUD_RELEASE);
  s.t += dt;
  return s;
}

/**
 * The still glow (reduced motion, and where the music cannot be read): a
 * gentle, fixed swell, fuller toward the bass, and the line half lit.
 */
export function stillSpectrum(bands = BANDS): Spectrum {
  const s = emptySpectrum(bands);
  for (let i = 0; i < bands; i++) {
    const t = i / Math.max(1, bands - 1);
    s.level[i] = 0.14 + 0.3 * (1 - t) ** 1.4;
  }
  s.loud = 0.55;
  return s;
}

/** A spectrum held at given levels (stories, screenshots). */
export function heldSpectrum(levels: ArrayLike<number>, bands = BANDS): Spectrum {
  const s = emptySpectrum(bands);
  for (let i = 0; i < bands; i++) s.level[i] = Math.min(1, Math.max(0, levels[i] ?? 0));
  s.loud = loudnessOf(s.level);
  return s;
}

export interface Layout {
  /** the bar's width, CSS px */
  width: number;
  /** the mirror point, CSS px from the left */
  centre: number;
  /** the longer way from it to an edge, CSS px: the bands spread over it */
  arm: number;
  /** between two bands, CSS px */
  spacing: number;
  /** how wide a band's light spreads, CSS px: wider than the spacing, so no band stands alone */
  sigma: number;
}

/** A band's light spreads at least this far (CSS px), however narrow the bar. */
export const MIN_SIGMA = 18;
/** ... and over this many bands' spacing. */
export const SPREAD = 1.7;

/** The light across a bar `width` wide. */
export function layoutGlow(width: number, anchor: Anchor, bands = BANDS): Layout {
  const w = Math.max(0, width);
  const centre = w * ANCHOR[anchor];
  const arm = Math.max(centre, w - centre);
  const spacing = arm / bands;
  return { width: w, centre, arm, spacing, sigma: Math.max(MIN_SIGMA, SPREAD * spacing) };
}

/** How much light a spot `u` CSS px from the mirror point keeps: all of it there, a third at the far end. */
export const gainAt = (u: number, arm: number) => (arm > 0 ? 1 - 0.68 * Math.min(1, u / arm) ** 1.2 : 1);

/** How far a band drifts, in band spacings, and how fast (radians a second). */
const DRIFT = 0.7;
const DRIFT_RATE = 0.31;
/** How much of the light the travelling brightness takes away at most. */
const FLOW = 0.22;

/** Where band `k` sits now, CSS px from the mirror point. */
const bandAt = (layout: Layout, k: number, t: number) =>
  layout.spacing * (k + 0.5 + DRIFT * Math.sin(DRIFT_RATE * t + k * 1.7));

/**
 * The light's height at `x` (CSS px from the bar's left), 0 to 1: a smooth
 * blend of the bands near it (each one also mirrored past the mirror point,
 * so the light runs through it without a crease), times how much the spot
 * keeps (gainAt), times a faint brightness that travels out along the edge.
 */
export function heightAt(layout: Layout, s: Spectrum, x: number): number {
  if (!layout.width) return 0;
  const u = x - layout.centre;
  const two = 2 * layout.sigma * layout.sigma;
  let sum = 0, weight = 0;
  for (let k = 0; k < s.level.length; k++) {
    const d = bandAt(layout, k, s.t);
    const a = u - d, b = u + d;
    const w = Math.exp(-(a * a) / two) + Math.exp(-(b * b) / two);
    sum += w * s.level[k]!;
    weight += w;
  }
  const blend = weight > 1e-6 ? sum / weight : 0;
  // the brightness that travels out from the mirror point (rounded there, so no crease)
  const r = Math.sqrt(u * u + 400);
  const flow = 1 - FLOW * (0.5 + 0.5 * Math.sin(r / 90 - 0.9 * s.t) * Math.sin(r / 47 - 0.5 * s.t + 1.3));
  return Math.min(1, blend * gainAt(Math.abs(u), layout.arm) * flow);
}

export interface Colours {
  /** the light: the album's accent (deeper on a light theme) */
  body: string;
  /** its warm foot along the edge: its lighter tint (on a light theme, deeper still) */
  core: string;
}

/** CSS px to one canvas px up the glow. */
export const Y_SCALE = 2;
/** How high the light's hot foot reaches, CSS px: the page's text over the glow keeps its contrast above it. */
export const FOOT = 16;

/** How strong the light is at its foot: on a light page a deep tone needs less to show. */
export interface Strength { body: number; core: number }
export const STRENGTH: Record<'dark' | 'light', Strength> = {
  dark: { body: 0.58, core: 0.8 },
  light: { body: 0.55, core: 0.6 },
};

/** The colour at no alpha (a gradient to plain transparent would pass through grey). */
export function clearOf(colour: string): string {
  const m = /^rgba?\(([^,]+),([^,]+),([^,)]+)/.exec(colour.replace(/\s+/g, ''));
  return m ? `rgba(${m[1]},${m[2]},${m[3]},0)` : 'transparent';
}

const withAlpha = (colour: string, a: number) => {
  const m = /^rgba?\(([^,]+),([^,]+),([^,)]+)/.exec(colour.replace(/\s+/g, ''));
  return m ? `rgba(${m[1]},${m[2]},${m[3]},${a})` : colour;
};

const gradients = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasGradient>>();
/** A fade from `colour` at the foot (0) to nothing at the top (-1, scaled to the light's height), made once per colour: an easing, no hard top. */
function gradientFor(ctx: CanvasRenderingContext2D, colour: string): CanvasGradient {
  let own = gradients.get(ctx);
  if (!own) gradients.set(ctx, (own = new Map()));
  const hit = own.get(colour);
  if (hit) return hit;
  const gradient = ctx.createLinearGradient(0, 0, 0, -1);
  gradient.addColorStop(0, colour);
  gradient.addColorStop(0.3, withAlpha(colour, 0.62));
  gradient.addColorStop(0.62, withAlpha(colour, 0.22));
  gradient.addColorStop(1, clearOf(colour));
  // a new cover's colour every so often: keep only the last few
  if (own.size > 8) own.clear();
  own.set(colour, gradient);
  return gradient;
}

/** The canvas's scale across, CSS px to one canvas px: a few samples a band's spread, the browser's smoothing does the rest. */
export const canvasScale = (layout: Layout) => Math.min(8, Math.max(2, layout.sigma / 5));

/**
 * Paints the light into a small canvas (`scale` CSS px to one canvas px
 * across, Y_SCALE up): one thin slice a canvas px, each the light's height
 * there, fading upward, with a warmer foot along the edge. The browser's
 * smoothing as it scales the canvas up blends the slices into one wash.
 */
export function paintGlow(ctx: CanvasRenderingContext2D, layout: Layout, s: Spectrum, colours: Colours, strength: Strength, scale: number): void {
  const { width, height } = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const body = gradientFor(ctx, colours.body);
  const core = gradientFor(ctx, colours.core);
  const foot = Math.max(1, FOOT / Y_SCALE);
  for (let i = 0; i < width; i++) {
    const v = heightAt(layout, s, (i + 0.5) * scale);
    const h = v * height;
    if (h < 0.5) continue;
    ctx.setTransform(1, 0, 0, h, 0, height);
    ctx.globalAlpha = strength.body * (0.55 + 0.45 * v);
    ctx.fillStyle = body;
    ctx.fillRect(i, 0, 1, -1);
    ctx.setTransform(1, 0, 0, Math.min(h * 0.4, foot), 0, height);
    ctx.globalAlpha = strength.core * v;
    ctx.fillStyle = core;
    ctx.fillRect(i, 0, 1, -1);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}
