/**
 * Adaptive colour: the playing cover's colour scheme, from Google's Material
 * Color Utilities (the algorithms behind Material You). The cover's pixels
 * are quantized (Celebi: Wu then weighted k-means), Score picks the colour a
 * UI theme should be built on, and SchemeContent builds tonal palettes around
 * it whose roles sit at fixed tones, so the contrast between roles holds for
 * any cover. Two schemes from the one source: SchemeContent for the accent
 * (it keeps the cover's own colour), SchemeTonalSpot for the surfaces (the
 * same hue, held to a low chroma, so the canvas and the bar stay quiet).
 * Loaded on demand (AdaptiveColour.tsx imports it dynamically).
 *
 * Which token takes which role:
 * - accent (--dew and its legacy names): primary's tone 40 / 80, tone
 *   100 / 20 for its label
 * - canvas: TonalSpot's surface (a near-neutral of the cover's hue); a
 *   faint wash of the primary palette behind the page
 * - selected pill / chip: a pale secondary tone, primary as its label
 * - the player bar: TonalSpot's secondary, one quiet surface a clear step
 *   (1.45:1 in light, its container tone in dark) away from
 *   the canvas; secondary tones that Contrast.darker / lighter find at 7:1
 *   and 5:1 for its two lines of text
 * - the bar's seek fill and keys: primary, a tone further out if the bar's
 *   own tone sits close (3:1 against the bar)
 * - the glow along the seek bar: a mid primary tone (50 dark, 70 light),
 *   held where the seek fill still reads 3:1 on top of it
 */
import { Contrast, Hct, QuantizerCelebi, SchemeContent, SchemeTonalSpot, Score, argbFromRgb, hexFromArgb } from '@material/material-color-utilities';

/** Score's fallback when no colour on the cover is fit for a theme (all grey, or no hue above 1 %). */
const NO_COLOUR = 0;

export interface CoverColours {
  /** the colour to build on, or null when the cover has none fit for a theme: the brand teal stays */
  source: number | null;
  /** the cover's darkest and lightest pixel (ARGB): the worst cases where the cover itself shows behind text */
  darkest: number;
  lightest: number;
}

/** The cover's colours from RGBA pixels (a small canvas sample). */
export function coverColours(rgba: ArrayLike<number>): CoverColours {
  const pixels: number[] = [];
  let darkest = 0xff808080, lightest = 0xff808080, dl = Infinity, ll = -Infinity;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 255) continue;
    const argb = argbFromRgb(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
    pixels.push(argb);
    const y = 0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!;
    if (y < dl) { dl = y; darkest = argb; }
    if (y > ll) { ll = y; lightest = argb; }
  }
  if (!pixels.length) return { source: null, darkest, lightest };
  const [best] = Score.score(QuantizerCelebi.quantize(pixels, 128), { desired: 1, filter: true, fallbackColorARGB: NO_COLOUR });
  return { source: best === undefined || best === NO_COLOUR ? null : best, darkest, lightest };
}

/** Just the source colour (tests, stories). */
export function sourceColour(rgba: ArrayLike<number>): number | null {
  return coverColours(rgba).source;
}

/** The theme's inks (tokens.css), which the cover's colours never replace outside the bar. */
export const THEME_INKS = {
  light: [0xff16202a, 0xff46525e, 0xff5e6975],
  dark: [0xffe7edf2, 0xffa9b5c0, 0xff8795a2],
} as const;

const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (argb: number) => 0.2126 * lin((argb >> 16) & 255) + 0.7152 * lin((argb >> 8) & 255) + 0.0722 * lin(argb & 255);
export const contrastOf = (a: number, b: number) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** `top` at opacity `alpha` over an opaque `bottom`, as ARGB. */
export const overArgb = (top: number, alpha: number, bottom: number) =>
  (0xff000000 | [16, 8, 0].reduce((acc, sh) => acc | (Math.round(((top >> sh) & 255) * alpha + ((bottom >> sh) & 255) * (1 - alpha)) << sh), 0)) >>> 0;

/**
 * The CSS filter saturate(1.2) that Now Playing's wash applies
 * (NowPlaying.module.css .wash), on an ARGB colour as the browser paints it.
 */
export function saturate(argb: number, k = 1.2): number {
  const r = (argb >> 16) & 255, g = (argb >> 8) & 255, b = argb & 255;
  const m = [
    [0.213 + 0.787 * k, 0.715 - 0.715 * k, 0.072 - 0.072 * k],
    [0.213 - 0.213 * k, 0.715 + 0.285 * k, 0.072 - 0.072 * k],
    [0.213 - 0.213 * k, 0.715 - 0.715 * k, 0.072 + 0.928 * k],
  ];
  const [R, G, B] = m.map((row) => Math.max(0, Math.min(255, Math.round(row[0]! * r + row[1]! * g + row[2]! * b))));
  return (0xff000000 | (R! << 16) | (G! << 8) | B!) >>> 0;
}

/**
 * Now Playing lays the blurred cover over the canvas (NowPlaying.module.css
 * .wash). Its opacity: the most, up to 0.45, at which the theme's three inks
 * (at 4.7:1, a margin over AA for the blur's edges) and the accent (3.2:1)
 * still read on the cover's darkest and lightest pixel, saturated as the wash
 * paints them and laid over the canvas. The blur only averages pixels, so
 * these are the worst case.
 */
export function washOpacity(canvas: number, accent: number, darkest: number, lightest: number, dark: boolean): number {
  const inks = THEME_INKS[dark ? 'dark' : 'light'];
  const extremes = [darkest, lightest].map((px) => saturate(px));
  for (let a = 0.45; a > 0; a = Math.round((a - 0.01) * 100) / 100) {
    const bgs = extremes.map((px) => overArgb(px, a, canvas));
    if (bgs.every((bg) => inks.every((ink) => contrastOf(ink, bg) >= 4.7) && contrastOf(accent, bg) >= 3.2)) return a;
  }
  return 0;
}

const rgbOf = (argb: number) => `${(argb >> 16) & 255}, ${(argb >> 8) & 255}, ${argb & 255}`;

/**
 * The --ad-* custom properties for a source colour in one theme. With the
 * cover's darkest and lightest pixel it also sets how strongly Now Playing
 * may show the cover itself (--ad-wash-opacity).
 */
export function adaptiveTokens(source: number, dark: boolean, extremes?: { darkest: number; lightest: number }): Record<string, string> {
  const hct = Hct.fromInt(source);
  const s = new SchemeContent(hct, dark, 0);
  const quiet = new SchemeTonalSpot(hct, dark, 0);
  // the accent at M3's fixed role tones (40 light, 80 dark), from the more
  // colourful of the two primary palettes: Content keeps a vivid cover's own
  // chroma; for a dull or very dark cover TonalSpot's chroma 36 keeps the
  // accent a colour (Content's own primary role follows the source's tone,
  // so a near-black cover gave a near-black accent)
  const p = s.primaryPalette.chroma >= quiet.primaryPalette.chroma ? s.primaryPalette : quiet.primaryPalette;
  const accentTone = dark ? 80 : 40;
  const sec = quiet.secondaryPalette;
  const hex = hexFromArgb;
  // the bar: TonalSpot's secondary at its container tone in dark (24 tones
  // over the canvas); in light the container tone sits too close to the
  // canvas, so the tone 1.45:1 under it, a clear step that the bar's own inks
  // still read on
  const canvasTone = Hct.fromInt(quiet.surface).tone;
  const barTone = dark ? Hct.fromInt(quiet.secondaryContainer).tone : Contrast.darkerUnsafe(canvasTone, 1.45);
  const barArgb = sec.tone(barTone);
  // the bar's text: aiming at 7:1 (its title) and 5:1 (its second line), so
  // the fade between two covers never passes under 4.5 on the way; the
  // *Unsafe searches give white or black when the aim is out of reach
  const inkTone = dark ? Math.max(90, Contrast.lighterUnsafe(barTone, 7)) : Math.min(10, Contrast.darkerUnsafe(barTone, 7));
  const ink2Tone = dark ? Contrast.lighterUnsafe(barTone, 5) : Contrast.darkerUnsafe(barTone, 5);
  const tintTone = dark ? 22 : 92;
  // the seek fill and the bar's keys: primary, moved further from the bar when its tone sits close
  const away = dark ? Contrast.lighter(barTone, 3.2) : Contrast.darker(barTone, 3.2);
  const fillTone = away < 0 ? (dark ? 100 : 0) : dark ? Math.max(80, away) : Math.min(40, away);
  // a problem said in the bar (the phone's mini bar): the error palette at 4.5:1 on the bar
  const dangerTone = dark ? Math.max(80, Contrast.lighterUnsafe(barTone, 4.8)) : Math.min(40, Contrast.darkerUnsafe(barTone, 4.8));
  const wash = extremes ? washOpacity(quiet.surface, p.tone(accentTone), extremes.darkest, extremes.lightest, dark) : 0.3;
  return {
    '--ad-accent': hex(p.tone(accentTone)),
    '--ad-accent-hi': hex(p.tone(dark ? 90 : 55)),
    '--ad-accent-lo': hex(p.tone(dark ? 65 : 30)),
    '--ad-accent-press': hex(p.tone(dark ? 85 : 25)),
    '--ad-accent-hover': hex(p.tone(dark ? 90 : 30)),
    '--ad-accent-ink': hex(p.tone(dark ? 20 : 100)),
    '--ad-tint': hex(sec.tone(tintTone)),
    '--ad-chip': hex(p.tone(accentTone)),
    '--ad-ring': hex(p.tone(accentTone)),
    '--ad-canvas': hex(quiet.surface),
    '--ad-wash': `rgba(${rgbOf(p.tone(dark ? 25 : 90))}, ${dark ? 0.35 : 0.45})`,
    '--ad-bar': hex(barArgb),
    '--ad-bar-ink': hex(sec.tone(inkTone)),
    '--ad-bar-ink-2': hex(sec.tone(ink2Tone)),
    '--ad-bar-line': hex(sec.tone(dark ? Math.min(100, barTone + 18) : Math.max(0, barTone - 16))),
    '--ad-bar-accent': hex(p.tone(fillTone)),
    '--ad-bar-danger': hex(quiet.errorPalette.tone(dangerTone)),
    '--ad-glow': hex(p.tone(dark ? 50 : 70)),
    '--ad-wash-opacity': String(wash),
    '--accent-rgb': rgbOf(p.tone(accentTone)),
    '--info-rgb': rgbOf(p.tone(accentTone)),
  };
}
