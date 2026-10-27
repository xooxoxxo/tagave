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
 * - the equalizer glow, an aurora under the bar's text and keys: three
 *   hues (primary, tertiary and a neighbour), each a vivid core along the
 *   bottom edge and a veil at about the bar's lightness rising behind the
 *   text, so the bar's pairs keep their rules (aurora.ts)
 */
import { Contrast, Hct, QuantizerCelebi, SchemeContent, SchemeTonalSpot, Score, argbFromRgb, hexFromArgb } from '@material/material-color-utilities';
import { auroraHues, auroraTokens } from './aurora';

/** Score's fallback when no colour on the cover is fit for a theme (all grey, or no hue above 1 %). */
const NO_COLOUR = 0;

/**
 * The cover's source colour from RGBA pixels (a small canvas sample), or null
 * when the cover has no usable colour: the app then keeps the brand teal.
 */
export function sourceColour(rgba: ArrayLike<number>): number | null {
  const pixels: number[] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 255) continue;
    pixels.push(argbFromRgb(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!));
  }
  if (!pixels.length) return null;
  const [best] = Score.score(QuantizerCelebi.quantize(pixels, 128), { desired: 1, filter: true, fallbackColorARGB: NO_COLOUR });
  return best === undefined || best === NO_COLOUR ? null : best;
}

const rgbOf = (argb: number) => `${(argb >> 16) & 255}, ${(argb >> 8) & 255}, ${argb & 255}`;

/** The --ad-* custom properties for a source colour in one theme. */
export function adaptiveTokens(source: number, dark: boolean): Record<string, string> {
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
    ...auroraTokens(auroraHues(p.hue, s.tertiaryPalette.hue), barArgb, {
      texts: [sec.tone(inkTone), sec.tone(ink2Tone)],
      marks: [p.tone(fillTone)],
    }, 'ad-'),
    '--accent-rgb': rgbOf(p.tone(accentTone)),
    '--info-rgb': rgbOf(p.tone(accentTone)),
  };
}
