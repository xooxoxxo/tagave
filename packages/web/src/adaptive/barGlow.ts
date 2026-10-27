/**
 * The equalizer glow's colour (--ad-glow under adaptive colour, --seek-glow
 * in a generated theme and the brand) and the light it may give where the
 * bar's text lies.
 *
 * The glow is a row of soft columns rising from the bottom edge of the bar
 * (components/BarGlow.module.css). Each column is brightest at the bottom
 * and fades fast: at most GLOW_PEAK strong at the edge, PROFILE of that
 * further up (48 % at a fifth of its height, 12 % by its middle). The bar's text and keys sit above a floor (measured in the app:
 * the second line's box starts 14.8 px over the mini bar's bottom edge and
 * 16.4 px over the desktop bar's, whose columns are 32 and 36 px tall at a
 * loud peak; the keys start 21 and 26 px up), so the light under them is
 * TEXT_ALPHA and MARK_ALPHA at most, a fraction of the peak.
 *
 * So the colour can stand apart from the bar: the accent's hue at full
 * chroma, at the tone furthest from the bar (light on a dark bar, deep on a
 * light one) that still keeps the title and second line at 4.5:1 and the
 * keys at 3:1 over that light, with 10 % to spare so a fade between two
 * covers holds too. The seek line lies at the columns' tops, where they have
 * faded out.
 */
import { Hct } from '@material/material-color-utilities';

/** The glow's strength at the bar's bottom edge, at a loud peak. */
export const GLOW_PEAK = 0.7;

/** A column's light up its height (0 the bar's edge, 1 its top), as a share of the peak; BarGlow.module.css draws these stops. */
export const PROFILE: ReadonlyArray<readonly [at: number, share: number]> = [[0, 1], [0.22, 0.48], [0.46, 0.12], [1, 0]];

/** The light at a height up a column at its full height (0 to 1). */
export function alphaAt(at: number): number {
  for (let i = 1; i < PROFILE.length; i++) {
    const [a0, s0] = PROFILE[i - 1]!, [a1, s1] = PROFILE[i]!;
    if (at <= a1) return GLOW_PEAK * (s0 + ((s1 - s0) * (Math.max(at, a0) - a0)) / (a1 - a0));
  }
  return 0;
}

/** Where the text and the keys start, as a share of the column's full height (the lower of the two bars). */
const TEXT_AT = Math.min(14.8 / 32, 16.4 / 36);
const MARK_AT = Math.min(21 / 32, 26 / 36);
/** The most light under the bar's text and under its keys. */
export const TEXT_ALPHA = alphaAt(TEXT_AT);
export const MARK_ALPHA = alphaAt(MARK_AT);

type RGB = [number, number, number];
const rgbOfArgb = (argb: number): RGB => [(argb >> 16) & 255, (argb >> 8) & 255, argb & 255];
const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: RGB, b: RGB) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** What the browser paints: `top` at alpha `a` over `bottom`, in sRGB. */
const over = (top: RGB, a: number, bottom: RGB): RGB => [0, 1, 2].map((i) => Math.round(top[i]! * a + bottom[i]! * (1 - a))) as RGB;

export interface BarInks {
  /** text on the bar (its title, its second line): 4.5:1 */
  texts: number[];
  /** the keys and the seek fill: 3:1 */
  marks: number[];
}

/**
 * Whether a glow keeps the bar's text at 4.5:1 and its keys at 3:1 over the
 * light it gives where they lie, at any loudness; `margin` asks for that
 * much more.
 */
export function glowHolds(glow: number, bar: number, inks: BarInks, margin = 1): boolean {
  const g = rgbOfArgb(glow), b = rgbOfArgb(bar);
  for (let k = 1; k <= 10; k++) {
    const underText = over(g, (TEXT_ALPHA * k) / 10, b);
    if (inks.texts.some((t) => ratio(rgbOfArgb(t), underText) < 4.5 * margin)) return false;
    const underKeys = over(g, (MARK_ALPHA * k) / 10, b);
    if (inks.marks.some((m) => ratio(rgbOfArgb(m), underKeys) < 3 * margin)) return false;
  }
  return true;
}

/** How far the glow at the bar's edge, at a loud peak, stands from the bar (luminance contrast): what the eye catches. */
export function glowShows(glow: number, bar: number): number {
  const b = rgbOfArgb(bar);
  return ratio(over(rgbOfArgb(glow), GLOW_PEAK, b), b);
}

/** The headroom a chosen glow keeps over the rules. */
const MARGIN = 1.04;
/** Enough contrast against the bar to catch the eye; past it, colour matters more than more contrast. */
export const GLOW_SHOWS = 2.2;

/**
 * The glow for a bar: the accent's hue at full chroma, at a tone that holds.
 * Of those that stand GLOW_SHOWS apart from the bar, the most colourful;
 * when none does, the one that stands furthest. Else the bar's own colour.
 */
export function barGlow(hue: number, bar: number, inks: BarInks): number {
  let best = bar, shown = 1, vivid: number | null = null, chroma = -1;
  for (let t = 2; t <= 98; t += 2) {
    const c = Hct.from(hue, 150, t).toInt();
    if (!glowHolds(c, bar, inks, MARGIN)) continue;
    const v = glowShows(c, bar);
    if (v > shown) { best = c; shown = v; }
    const ch = Hct.fromInt(c).chroma;
    if (v >= GLOW_SHOWS && ch > chroma) { vivid = c; chroma = ch; }
  }
  return vivid ?? best;
}
