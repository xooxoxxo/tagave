/**
 * The equalizer glow's colours: an aurora along the foot of the window, in
 * three hues from the cover's scheme (or the theme's accents), each in two
 * parts (components/BarGlow.module.css):
 *
 * - the core: a vivid tone far from the bar's (light on a dark bar, deep on
 *   a light one), only along the bottom edge, under the bar's text. Its glow
 *   blurs up a little: AT_TEXT of it at most reaches the text.
 * - the veil: the same hue at full chroma and at about the bar's own
 *   lightness, rising up the bar behind the text and keys. Colour rises,
 *   brightness does not: over any amount of veil the bar's title and second
 *   line keep 4.5:1 and its keys and seek fill 3:1.
 *
 * Each hue's veil is the most colourful tone that holds with 22 % to spare
 * (the cores' blur and a fade between two covers spend some); each core the most
 * colourful tone at least CORE_SHOWS from the bar that still holds where its
 * blur reaches the text (over every veil), else the one that stands
 * furthest. adaptive/scheme.test.ts and themes/engine.test.ts sweep covers,
 * fades, starters and seeds.
 */
import { Hct } from '@material/material-color-utilities';

/** How much of a core's light at most reaches the text (its band ends under it; its blur rises a little). */
export const AT_TEXT = 0.12;
/** Enough contrast against the bar for a core to read as light. */
export const CORE_SHOWS = 2.4;
const MARGIN = 1.04;
/** The veil keeps more in hand: the cores' blur at the text spends some of it. */
const VEIL_MARGIN = 1.22;

type RGB = [number, number, number];
const rgbOf = (argb: number): RGB => [(argb >> 16) & 255, (argb >> 8) & 255, argb & 255];
const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const ratio = (a: RGB, b: RGB) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** What the browser paints: `top` at alpha `a` over `bottom`, in sRGB. */
export const over = (top: RGB, a: number, bottom: RGB): RGB => [0, 1, 2].map((i) => Math.round(top[i]! * a + bottom[i]! * (1 - a))) as RGB;
export const rgbOfArgb = rgbOf;

export interface BarInks {
  /** the bar's title and second line: 4.5:1 */
  texts: number[];
  /** its keys and seek fill: 3:1 */
  marks: number[];
}

const reads = (bg: RGB, inks: BarInks, margin: number) =>
  inks.texts.every((t) => ratio(rgbOf(t), bg) >= 4.5 * margin) && inks.marks.every((m) => ratio(rgbOf(m), bg) >= 3 * margin);

/** The backgrounds the text can have: the bar under any amount of a veil, and of a core's blur over that. */
export function litBackgrounds(bar: number, veils: number[], cores: number[]): RGB[] {
  const b = rgbOf(bar);
  const out: RGB[] = [b];
  for (const v of veils) {
    for (let k = 1; k <= 4; k++) {
      const under = over(rgbOf(v), k / 4, b);
      out.push(under);
      for (const c of cores) out.push(over(rgbOf(c), AT_TEXT, under));
    }
  }
  // two veils blending into each other
  for (let i = 0; i < veils.length; i++) for (let j = i + 1; j < veils.length; j++) out.push(over(rgbOf(veils[i]!), 0.5, rgbOf(veils[j]!)));
  return out;
}

/** Whether the bar's text, keys and seek fill read over everything the aurora can put under them. */
export function auroraHolds(bar: number, veils: number[], cores: number[], inks: BarInks, margin = 1): boolean {
  return litBackgrounds(bar, veils, cores).every((bg) => reads(bg, inks, margin));
}

const vivid = (hue: number, tone: number) => Hct.from(hue, 150, tone).toInt();

/** The hue's veil: the most colourful tone within `reach` of the bar's that the text reads over. */
function veilFor(hue: number, bar: number, inks: BarInks, reach = 14): number {
  const barTone = Hct.fromInt(bar).tone;
  let best = bar, chroma = -1;
  for (let t = Math.max(0, Math.round(barTone) - reach); t <= Math.min(100, Math.round(barTone) + reach); t++) {
    const c = vivid(hue, t);
    if (!reads(rgbOf(c), inks, VEIL_MARGIN)) continue;
    const ch = Hct.fromInt(c).chroma;
    if (ch > chroma) { best = c; chroma = ch; }
  }
  return best;
}

/** The hue's core: the most colourful tone that stands CORE_SHOWS from the bar and holds where its blur reaches the text. */
function coreFor(hue: number, bar: number, veils: number[], inks: BarInks): number {
  const b = rgbOf(bar);
  // on a dark bar light is lighter; on a light one a deep, vivid tone reads as coloured light
  const dark = Hct.fromInt(bar).tone < 50;
  const from = dark ? Math.ceil(Hct.fromInt(bar).tone / 2) * 2 + 6 : 4;
  let far = bar, farShows = 1, pick: number | null = null, chroma = -1;
  for (let t = from; t <= 96; t += 2) {
    const c = vivid(hue, t);
    if (!auroraHolds(bar, veils, [c], inks, MARGIN)) continue;
    const shows = ratio(rgbOf(c), b);
    if (shows > farShows) { far = c; farShows = shows; }
    const ch = Hct.fromInt(c).chroma;
    if (shows >= CORE_SHOWS && ch > chroma) { pick = c; chroma = ch; }
  }
  return pick ?? far;
}

/** Three hues, spread apart when they sit close (a single-hue cover still gets an aurora of neighbours). */
export function auroraHues(first: number, second: number): number[] {
  const gap = Math.abs(((second - first + 540) % 360) - 180);
  const b = gap < 30 ? first + 55 : second;
  return [first, b, first - 45].map((h) => ((h % 360) + 360) % 360);
}

/** The aurora's tokens for a bar: --{prefix}aur-core-1..3 and --{prefix}aur-veil-1..3. */
export function auroraTokens(hues: number[], bar: number, inks: BarInks, prefix = ''): Record<string, string> {
  // the veils blend into each other: where a blend would not read, they come closer to the bar's lightness
  let reach = 14;
  let veils = hues.map((h) => veilFor(h, bar, inks, reach));
  while (reach > 0 && !auroraHolds(bar, veils, [], inks, MARGIN)) veils = hues.map((h) => veilFor(h, bar, inks, --reach));
  const cores = hues.map((h) => coreFor(h, bar, veils, inks));
  const hex = (argb: number) => `#${(argb & 0xffffff).toString(16).padStart(6, '0')}`;
  const out: Record<string, string> = {};
  hues.forEach((_, i) => {
    out[`--${prefix}aur-core-${i + 1}`] = hex(cores[i]!);
    out[`--${prefix}aur-veil-${i + 1}`] = hex(veils[i]!);
  });
  return out;
}

/** How far a core stands from the bar (luminance contrast): what the eye catches as light. */
export const coreShows = (core: number, bar: number) => ratio(rgbOf(core), rgbOf(bar));
