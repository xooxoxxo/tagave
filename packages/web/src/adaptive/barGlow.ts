/**
 * The equalizer glow's colour (--ad-glow under adaptive colour, --seek-glow
 * in a generated theme and the brand): the glow lies inside the player bar,
 * under its text, keys and seek line, at most BAR_GLOW_PEAK strong
 * (components/BarGlow.module.css). So the colour is the most vivid tone of
 * the accent's palette that keeps every one of the bar's pairs at its rule
 * wherever the glow lies, at any strength up to the peak: its two lines of
 * text at 4.5:1, the seek fill and the keys at 3:1. (A problem said in the
 * bar has no glow under it: the glow goes out while a track fails.)
 * The bar's text sits close to its rules (its second line at 5:1), so the
 * glow can barely change the bar's lightness: what it has is colour. Every
 * tone of the accent's hue at its fullest chroma is tried, and the one that
 * holds and stands furthest from the bar at the peak wins: a vivid hue at
 * about the bar's lightness, a neon tint rather than a light. The bar's own
 * colour (no glow) is the last resort and never needed in practice (the
 * tests sweep covers, cross-fades and seeds).
 */
import { Hct } from '@material/material-color-utilities';


/** The glow's strongest point, as an alpha over the bar (BarGlow.module.css writes it as a percentage). */
export const BAR_GLOW_PEAK = 0.6;

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
  /** the seek fill and the keys: 3:1 */
  marks: number[];
}

/**
 * Whether a glow colour keeps the bar's pairs at their rules at every
 * strength up to the peak; `margin` asks for that much more (the choice
 * keeps some, so the 600 ms fade between two covers holds on the way).
 */
export function glowHolds(glow: number, bar: number, inks: BarInks, margin = 1, peak = BAR_GLOW_PEAK): boolean {
  const g = rgbOfArgb(glow), b = rgbOfArgb(bar);
  for (let k = 1; k <= 10; k++) {
    const lit = over(g, (peak * k) / 10, b);
    if (inks.texts.some((t) => ratio(rgbOfArgb(t), lit) < 4.5 * margin)) return false;
    if (inks.marks.some((m) => ratio(rgbOfArgb(m), lit) < 3 * margin)) return false;
  }
  return true;
}

/** The headroom a chosen glow keeps over the rules. */
const MARGIN = 1.1;

/** How far the glow at its peak stands from the bar (sRGB distance): what the eye sees of it. */
function seen(glow: number, bar: number): number {
  const b = rgbOfArgb(bar), lit = over(rgbOfArgb(glow), BAR_GLOW_PEAK, b);
  return Math.hypot(lit[0] - b[0], lit[1] - b[1], lit[2] - b[2]);
}

/** The glow for a bar: the accent's hue at full chroma, at the tone that holds and shows most; else the bar's own colour. */
export function barGlow(hue: number, bar: number, inks: BarInks): number {
  let best = bar, shown = 0;
  for (let t = 4; t <= 98; t += 2) {
    const c = Hct.from(hue, 150, t).toInt();
    if (!glowHolds(c, bar, inks, MARGIN)) continue;
    const v = seen(c, bar);
    if (v > shown) { best = c; shown = v; }
  }
  return best;
}
