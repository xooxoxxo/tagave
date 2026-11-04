/**
 * The equalizer glow's motion and drawing (BarGlow.tsx): the bands of
 * adaptive/levels.ts become columns of light rising from the player bar's
 * top edge, an equalizer laid out sideways and mirrored about one point (the
 * bass there, the treble out toward both ends). On a desktop that point sits
 * on the bar's right side, so the light comes from there and falls off
 * toward the left; on a phone it is the mini bar's middle.
 *
 * Every band has a quick attack and a slower release, and a peak that holds
 * a moment before it falls, so a beat reads at once and a column settles
 * rather than flickers. The line along the edge follows the overall
 * loudness. Pure functions here (tests); BarGlow runs the one loop.
 */
import { BANDS } from '../adaptive/levels';

/** Time constants (s): a band rises within about 50 ms and falls over about 300. */
export const ATTACK = 0.025;
export const RELEASE = 0.13;
/** A band's peak holds this long (s), then falls at FALL of the column's height a second. */
export const HOLD = 0.3;
export const FALL = 1.2;
/** The line's loudness: a touch slower both ways than a band. */
const LOUD_ATTACK = 0.03;
const LOUD_RELEASE = 0.16;

/** Where the mirror point sits, as a share of the bar's width. */
export const ANCHOR = { right: 0.72, centre: 0.5 } as const;
export type Anchor = keyof typeof ANCHOR;

export interface Spectrum {
  /** each band's column, 0 to 1 */
  level: Float32Array;
  /** each band's held peak, 0 to 1 */
  peak: Float32Array;
  /** how long each peak has held (s) */
  held: Float32Array;
  /** the line: overall loudness, 0 to 1 */
  loud: number;
}

export const emptySpectrum = (bands = BANDS): Spectrum => ({ level: new Float32Array(bands), peak: new Float32Array(bands), held: new Float32Array(bands), loud: 0 });

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
    const level = approach(s.level[i]!, v, dt, ATTACK, RELEASE);
    s.level[i] = level;
    if (level >= s.peak[i]!) {
      s.peak[i] = level;
      s.held[i] = 0;
    } else {
      s.held[i]! += dt;
      if (s.held[i]! > HOLD) s.peak[i] = Math.max(level, s.peak[i]! - FALL * dt);
    }
  }
  s.loud = approach(s.loud, loudnessOf(raw), dt, LOUD_ATTACK, LOUD_RELEASE);
  return s;
}

/**
 * The still glow (reduced motion, and where the music cannot be read): a
 * gentle, fixed equalizer, fuller in the bass, and the line half lit.
 */
export function stillSpectrum(bands = BANDS): Spectrum {
  const s = emptySpectrum(bands);
  for (let i = 0; i < bands; i++) {
    const t = i / Math.max(1, bands - 1);
    s.level[i] = 0.12 + 0.3 * (1 - t) ** 1.4;
    s.peak[i] = s.level[i]!;
  }
  s.loud = 0.55;
  return s;
}

/** A spectrum held at given levels (stories, screenshots): the peaks a little above. */
export function heldSpectrum(levels: ArrayLike<number>, bands = BANDS): Spectrum {
  const s = emptySpectrum(bands);
  for (let i = 0; i < bands; i++) {
    const v = Math.min(1, Math.max(0, levels[i] ?? 0));
    s.level[i] = v;
    s.peak[i] = Math.min(1, v + 0.06);
  }
  s.loud = loudnessOf(s.level);
  return s;
}

export interface Column {
  /** its middle, in CSS px from the bar's left */
  x: number;
  /** its first band, and how many it shows (the loudest of them): more than one on a narrow bar */
  band: number;
  span: number;
  /** 0 to 1: how much of its band it shows (the light falls off away from the mirror point) */
  gain: number;
}

export interface Layout {
  /** the mirror point, CSS px from the left */
  centre: number;
  /** one column's width, CSS px */
  pitch: number;
  columns: Column[];
}

/** The narrowest a column gets, CSS px. */
export const MIN_PITCH = 10;

/** How much a column `k` steps from the mirror point shows: all of it there, a quarter at the far end. */
export const gainAt = (k: number, bands = BANDS) => 1 - 0.75 * (k / Math.max(1, bands - 1)) ** 1.3;

/**
 * The columns across a bar `width` wide: the bass at the mirror point, a
 * band a step further out on each side, every band on the longer side (the
 * left one on a desktop), the shorter side cut off by the bar's edge.
 */
export function layoutColumns(width: number, anchor: Anchor, bands = BANDS): Layout {
  const centre = width * ANCHOR[anchor];
  const arm = Math.max(centre, width - centre);
  // a narrow bar (a phone) takes the bands two or more to a column, so a column stays MIN_PITCH wide
  const span = width > 0 ? Math.max(1, Math.ceil((MIN_PITCH * (bands - 0.5)) / arm)) : 1;
  const count = Math.ceil(bands / span);
  const pitch = width > 0 ? arm / (count - 0.5) : 0;
  const columns: Column[] = [];
  if (!pitch) return { centre, pitch, columns };
  for (let k = 0; k < count; k++) {
    for (const side of k === 0 ? [0] : [-1, 1]) {
      const x = centre + side * k * pitch;
      if (x < -pitch / 2 || x > width + pitch / 2) continue;
      columns.push({ x, band: k * span, span: Math.min(span, bands - k * span), gain: gainAt(k, count) });
    }
  }
  return { centre, pitch, columns };
}

export interface Colours {
  /** the columns: the album's accent (deeper on a light theme) */
  body: string;
  /** their hot base: its lighter tint (on a light theme, deeper still) */
  core: string;
}

/** CSS px to one canvas px up the glow. */
export const Y_SCALE = 2;
/** How high a column's hot foot reaches, CSS px: the page's text over the glow keeps its contrast above it. */
export const FOOT = 16;

/** How strong the light is at a column's foot: on a light page a deep tone needs less to show. */
export interface Strength { body: number; core: number }
export const STRENGTH: Record<'dark' | 'light', Strength> = {
  dark: { body: 0.46, core: 0.85 },
  light: { body: 0.4, core: 0.6 },
};

const loudest = (of: Float32Array, c: Column) => {
  let m = 0;
  for (let i = c.band; i < c.band + c.span; i++) if (of[i]! > m) m = of[i]!;
  return m;
};

/** The colour at no alpha (a gradient to plain transparent would pass through grey). */
export function clearOf(colour: string): string {
  const m = /^rgba?\(([^,]+),([^,]+),([^,)]+)/.exec(colour.replace(/\s+/g, ''));
  return m ? `rgba(${m[1]},${m[2]},${m[3]},0)` : 'transparent';
}

let cached: { ctx: CanvasRenderingContext2D; colour: string; gradient: CanvasGradient } | null = null;
/** A column's fade, 0 at its foot to -1 at its top (scaled to its height), made once per colour. */
function gradientFor(ctx: CanvasRenderingContext2D, colour: string): CanvasGradient {
  if (cached?.ctx === ctx && cached.colour === colour) return cached.gradient;
  const gradient = ctx.createLinearGradient(0, 0, 0, -1);
  gradient.addColorStop(0, colour);
  gradient.addColorStop(0.45, colour.startsWith('rgb(') ? colour.replace('rgb(', 'rgba(').replace(')', ', 0.42)') : colour);
  gradient.addColorStop(1, clearOf(colour));
  cached = { ctx, colour, gradient };
  return gradient;
}

/**
 * Paints the columns into a small canvas (`scale` CSS px to one canvas px across, two up):
 * the browser's smoothing as it scales the canvas up softens every column
 * into a glow, without a blur filter. A column fades out toward its top;
 * its foot burns in the core tint; its peak is a faint tick above it.
 */
export function paintColumns(ctx: CanvasRenderingContext2D, layout: Layout, s: Spectrum, colours: Colours, strength: Strength, scale: number): void {
  const { width, height } = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const body = gradientFor(ctx, colours.body);
  const w = Math.max(1, (layout.pitch * 0.62) / scale);
  for (const c of layout.columns) {
    const level = loudest(s.level, c) * c.gain;
    const x = c.x / scale - w / 2;
    const h = level * height;
    if (h >= 0.5) {
      // the column: the accent, fading upward
      ctx.setTransform(1, 0, 0, h, 0, height);
      ctx.globalAlpha = strength.body * (0.5 + 0.5 * c.gain);
      ctx.fillStyle = body;
      ctx.fillRect(x, 0, w, -1);
      // its foot: the tint, as hot as the band is loud, only along the edge (under FOOT px), where no text sits
      ctx.setTransform(1, 0, 0, Math.min(h * 0.34, FOOT / Y_SCALE), 0, height);
      ctx.globalAlpha = strength.core * level;
      ctx.fillStyle = colours.core;
      ctx.fillRect(x + w * 0.15, 0, w * 0.7, -1);
    }
    const p = loudest(s.peak, c) * c.gain * height;
    if (p - h >= 1) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.5 * strength.body * c.gain;
      ctx.fillStyle = colours.body;
      ctx.fillRect(x, height - p, w, 1);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

/** The canvas's scale: about four canvas px a column, so neighbours stay apart once smoothed. */
export const canvasScale = (pitch: number) => Math.min(6, Math.max(1, pitch / 4));
