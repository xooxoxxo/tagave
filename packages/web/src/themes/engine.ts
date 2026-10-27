/**
 * Themes, the engine. A theme is a seed colour, optionally a second accent,
 * run through the same Material scheme as adaptive colour
 * (src/adaptive/scheme.ts). Unlike adaptive colour, which keeps the theme's
 * inks and surfaces and only moves the accent, the canvas and the bar, a
 * theme sets every colour token: surfaces, hairlines, the three inks, the
 * accent family, the player bar. Each text colour is found by tone search
 * against the surfaces it sits on, so the contrast holds for any seed
 * (engine.test.ts sweeps random seeds in both modes).
 *
 * The second accent, when there is one, is the "live" colour: the player's
 * seek fill, its keys and the glow. Everything else that is accent (buttons,
 * links, rings, selected chips) stays the first.
 *
 * Adaptive and Classic set nothing: the brand tokens (tokens.css) stay, and
 * Adaptive hands the accent, the canvas and the bar to the playing cover
 * (AdaptiveColour.tsx). The player bar of a generated theme is written to
 * --th-bar*, which styles/themes.css hands to the bar while data-themed is
 * set; the logo keeps the brand teal through --logo-* (BrandMark).
 *
 * Loaded on demand (ThemeColours.tsx imports it dynamically; Settings ›
 * Appearance imports it directly): the first paint uses the tokens cached
 * by themeChoice.ts.
 */
import { Contrast, Hct, SchemeContent, SchemeTonalSpot, TonalPalette, argbFromHex, hexFromArgb } from '@material/material-color-utilities';
import type { ThemeChoice, ThemeId, ThemeSpec } from '@tagave/shared';
import { BRAND_TOKENS } from '../adaptive/brand';
import { barGlow } from '../adaptive/barGlow';

export type { ThemeChoice, ThemeId, ThemeSpec };

/** The brand teal (tokens.css --dew). */
export const CLASSIC_SEED = '#276a82';
/**
 * Moody: the moody test cover's source colour (Score on Celebi, as
 * adaptive colour reads it: #1b1a2d, a dark indigo) with its lightest pixel,
 * the amber moon (#c88a39), as the second accent.
 */
export const STARTERS: Record<'classic' | 'moody' | 'mono', ThemeSpec> = {
  classic: { seed: CLASSIC_SEED },
  moody: { seed: '#1b1a2d', accent2: '#c88a39' },
  mono: { seed: '#5e6975', mono: true },
};
export const THEME_LABELS: Record<ThemeId, string> = { adaptive: 'Adaptive', classic: 'Classic', moody: 'Moody', mono: 'Mono', custom: 'Custom' };
export const THEME_ORDER: ThemeId[] = ['adaptive', 'classic', 'moody', 'mono', 'custom'];
/** Custom before the person has made one: a green. */
export const CUSTOM_START: ThemeSpec = { seed: seedFromHue(150) };

/** The spec a choice generates its tokens from, or null for the brand tokens (Adaptive, Classic). */
export function generatedSpec(choice: ThemeChoice): ThemeSpec | null {
  if (choice.theme === 'moody' || choice.theme === 'mono') return STARTERS[choice.theme];
  if (choice.theme === 'custom') return choice.custom ?? CUSTOM_START;
  return null;
}

/** WCAG 2.x relative luminance of an ARGB colour. */
function luminance(argb: number): number {
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((argb >> 16) & 255) + 0.7152 * lin((argb >> 8) & 255) + 0.0722 * lin(argb & 255);
}
/** The WCAG 2.x contrast ratio of two ARGB colours. */
export function contrastOf(a: number, b: number): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const clampTone = (t: number) => Math.max(0, Math.min(100, t));
/** The tone nearest `want`, moving away from the background, at which `pal` reads `ratio` on every one of `bgs`. */
function toneFor(pal: TonalPalette, want: number, bgs: number[], ratio: number, dark: boolean): number {
  let t = want;
  for (let i = 0; i < 101; i++) {
    const argb = pal.tone(t);
    if (bgs.every((bg) => contrastOf(argb, bg) >= ratio)) return t;
    const next = clampTone(t + (dark ? 1 : -1));
    if (next === t) break;
    t = next;
  }
  return dark ? 100 : 0;
}

interface Palettes { p: TonalPalette; n: TonalPalette; s: TonalPalette; live: TonalPalette; err: TonalPalette }

function palettesOf(spec: ThemeSpec, dark: boolean): Palettes {
  const hct = Hct.fromInt(argbFromHex(spec.seed));
  const spot = new SchemeTonalSpot(hct, dark, 0);
  const second = spec.accent2 ? Hct.fromInt(argbFromHex(spec.accent2)) : null;
  if (spec.mono) {
    const p = TonalPalette.fromHueAndChroma(hct.hue, 4);
    const live = second ? TonalPalette.fromHueAndChroma(second.hue, Math.max(36, second.chroma)) : p;
    return { p, n: TonalPalette.fromHueAndChroma(hct.hue, 1.5), s: TonalPalette.fromHueAndChroma(hct.hue, 3), live, err: spot.errorPalette };
  }
  const content = new SchemeContent(hct, dark, 0);
  // the more colourful primary, as adaptive colour does: Content keeps a
  // vivid seed's chroma, TonalSpot's 36 keeps a dull or dark seed a colour
  const p = content.primaryPalette.chroma >= spot.primaryPalette.chroma ? content.primaryPalette : spot.primaryPalette;
  const live = second ? TonalPalette.fromHueAndChroma(second.hue, Math.max(36, second.chroma)) : p;
  // surfaces: the seed's hue at a quiet chroma, a little stronger in dark
  // where a tinted near-black is what makes a theme read as one
  const n = TonalPalette.fromHueAndChroma(hct.hue, dark ? 8 : 5);
  return { p, n, s: spot.secondaryPalette, live, err: spot.errorPalette };
}

const rgbOf = (argb: number) => `${(argb >> 16) & 255}, ${(argb >> 8) & 255}, ${argb & 255}`;

export interface Generated { tokens: Record<string, string>; pairs: ContrastPair[] }
export interface ContrastPair { name: string; fg: string; bg: string; ratio: number; min: number }

/** The logo keeps the brand teal whatever the theme (BrandMark reads these first). */
function logoTokens(dark: boolean): Record<string, string> {
  const b = BRAND_TOKENS[dark ? 'dark' : 'light'];
  return { '--logo-dew': b['--ad-accent']!, '--logo-dew-hi': b['--ad-accent-hi']!, '--logo-dew-lo': b['--ad-accent-lo']!, '--logo-dew-ink': b['--ad-accent-ink']! };
}

/** Every colour token for a theme in one mode, plus the pairs it was guarded on. */
export function generate(spec: ThemeSpec, dark: boolean): Generated {
  const { p, n, s, live, err } = palettesOf(spec, dark);
  const T = (light: number, d: number) => (dark ? d : light);
  const canvas = n.tone(T(98, 6));
  const surface = n.tone(T(100, 10));
  const mist = n.tone(T(95, 14));
  const mist2 = n.tone(T(91, 18));
  const line = n.tone(T(90, 22));
  const lineStrong = n.tone(T(80, 32));
  const surfaces = [canvas, surface, mist];
  const ink = n.tone(toneFor(n, T(10, 94), surfaces, 12, dark));
  const ink2 = n.tone(toneFor(n, T(32, 76), surfaces, 6.5, dark));
  const ink3 = n.tone(toneFor(n, T(42, 64), surfaces, 4.6, dark));
  // the accent: a link on any surface at 4.5, its label on it at 4.5
  const dewTone = toneFor(p, T(40, 80), [canvas, surface], 4.6, dark);
  const dew = p.tone(dewTone);
  const dewInk = p.tone(toneFor(p, T(100, 20), [dew], 4.6, !dark));
  // the selected pill and chip: the accent's hue, held quiet (a vivid seed's own chroma shouts at tone 93)
  const tint = TonalPalette.fromHueAndChroma(p.hue, Math.min(p.chroma, 20)).tone(T(93, 22));
  const chipInk = p.tone(toneFor(p, T(30, 90), [tint], 4.6, dark));
  const ring = p.tone(toneFor(p, T(40, 80), [canvas, surface], 3, dark));
  const danger = err.tone(toneFor(err, T(40, 80), [canvas, surface], 4.6, dark));
  // the bar: as adaptive colour builds it (scheme.ts), from this theme's palettes
  const canvasTone = Hct.fromInt(canvas).tone;
  const barTone = dark ? 26 : Contrast.darkerUnsafe(canvasTone, 1.45);
  const bar = s.tone(barTone);
  const barInk = s.tone(toneFor(s, T(10, 92), [bar], 7, dark));
  const barInk2 = s.tone(toneFor(s, T(30, 80), [bar], 5, dark));
  const barAccent = live.tone(toneFor(live, T(40, 80), [bar], 3.2, dark));
  const barDanger = err.tone(toneFor(err, T(40, 80), [bar], 4.6, dark));
  // the equalizer glow, inside the bar (adaptive/barGlow.ts)
  const glow = barGlow(live.hue, bar, { texts: [barInk, barInk2], marks: [barAccent] });
  const hex = hexFromArgb;
  const tokens: Record<string, string> = {
    '--canvas': hex(canvas), '--surface': hex(surface), '--mist': hex(mist), '--mist-2': hex(mist2),
    '--line': hex(line), '--line-strong': hex(lineStrong),
    '--ink': hex(ink), '--ink-2': hex(ink2), '--ink-3': hex(ink3),
    '--dew': hex(dew), '--dew-hi': hex(p.tone(T(55, 90))), '--dew-lo': hex(p.tone(T(30, 65))), '--dew-press': hex(p.tone(T(25, 85))),
    '--dew-ink': hex(dewInk), '--dew-tint': hex(tint), '--chip-on-ink': hex(chipInk), '--ring': hex(ring),
    '--danger': hex(danger),
    '--seek-glow': hex(glow),
    '--glass': `rgba(${rgbOf(n.tone(T(99, 16)))}, ${T(0.62, 0.55)})`,
    '--shadow-tint': rgbOf(n.tone(T(20, 0))),
    '--wash': `radial-gradient(1200px 600px at 80% -10%, rgba(${rgbOf(p.tone(T(90, 25)))}, ${T(0.5, 0.4)}), transparent 70%)`,
    '--accent-rgb': rgbOf(dew), '--info-rgb': rgbOf(dew),
    '--accent-hover': hex(p.tone(T(30, 90))), '--accent-active': hex(p.tone(T(25, 85))),
    '--chevron': `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%23${hex(ink3).slice(1)}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5'/%3E%3C/svg%3E")`,
    // the player bar, the phone's mini bar and the account strip (styles/themes.css)
    '--th-bar': hex(bar), '--th-bar-ink': hex(barInk), '--th-bar-ink-2': hex(barInk2),
    '--th-bar-line': hex(s.tone(dark ? Math.min(100, barTone + 18) : Math.max(0, barTone - 16))),
    '--th-bar-accent': hex(barAccent), '--th-bar-danger': hex(barDanger),
    ...logoTokens(dark),
  };
  const pair = (name: string, fg: number, bg: number, min: number): ContrastPair => ({ name, fg: hex(fg), bg: hex(bg), ratio: Math.round(contrastOf(fg, bg) * 100) / 100, min });
  const pairs = [
    pair('ink / canvas', ink, canvas, 7), pair('ink / mist', ink, mist, 7),
    pair('ink-2 / mist', ink2, mist, 6.5), pair('ink-3 / mist', ink3, mist, 4.5), pair('ink-3 / surface', ink3, surface, 4.5),
    pair('link / canvas', dew, canvas, 4.5), pair('link / surface', dew, surface, 4.5),
    pair('button label / accent', dewInk, dew, 4.5), pair('chip label / tint', chipInk, tint, 4.5),
    pair('danger / canvas', danger, canvas, 4.5),
    pair('bar ink / bar', barInk, bar, 7), pair('bar ink-2 / bar', barInk2, bar, 4.5),
    pair('bar danger / bar', barDanger, bar, 4.5),
    pair('focus ring / canvas', ring, canvas, 3), pair('seek fill / bar', barAccent, bar, 3),
  ];
  return { tokens, pairs };
}

/** Both modes' tokens, as themeChoice.ts caches them for the first paint. */
export function tokensFor(spec: ThemeSpec): { light: Record<string, string>; dark: Record<string, string> } {
  return { light: generate(spec, false).tokens, dark: generate(spec, true).tokens };
}

/** The lowest text ratio and the lowest non-text (ring, seek fill) ratio. */
export function minRatios(spec: ThemeSpec, dark: boolean): { text: number; nonText: number } {
  const { pairs } = generate(spec, dark);
  const text = pairs.filter((q) => q.min >= 4.5);
  const non = pairs.filter((q) => q.min < 4.5);
  return { text: Math.min(...text.map((q) => q.ratio)), nonText: Math.min(...non.map((q) => q.ratio)) };
}

/**
 * The brand tokens a mini preview needs (tokens.css and the brand bar of
 * adaptive/brand.ts), for the Classic and Adaptive cards: the page's own
 * tokens may be another theme's.
 */
export function brandMiniTokens(dark: boolean): Record<string, string> {
  const b = BRAND_TOKENS[dark ? 'dark' : 'light'];
  return dark
    ? { '--canvas': '#0d1115', '--surface': '#141a20', '--mist-2': '#222c35', '--line': '#29333d', '--line-strong': '#3a4651', '--ink': '#e7edf2', '--ink-3': '#8795a2', '--dew': '#5fb0cc', '--dew-tint': '#16303a', '--th-bar': b['--ad-bar']!, '--th-bar-ink': b['--ad-bar-ink']!, '--th-bar-line': b['--ad-bar-line']!, '--th-bar-accent': b['--ad-bar-accent']! }
    : { '--canvas': '#f6f8fa', '--surface': '#ffffff', '--mist-2': '#dfe5ea', '--line': '#dce2e8', '--line-strong': '#c3ccd5', '--ink': '#16202a', '--ink-3': '#5e6975', '--dew': '#276a82', '--dew-tint': '#e3f0f5', '--th-bar': b['--ad-bar']!, '--th-bar-ink': b['--ad-bar-ink']!, '--th-bar-line': b['--ad-bar-line']!, '--th-bar-accent': b['--ad-bar-accent']! };
}

/** A seed from HCT hue and chroma, at the tone the picker shows it (the scheme decides the role tones). */
export function seedFromHue(hue: number, chroma = 48, tone = 50): string {
  return hexFromArgb(Hct.from(hue, chroma, tone).toInt());
}

/** A colour's HCT hue, chroma and tone. */
export function hctOf(hex: string): { hue: number; chroma: number; tone: number } {
  const h = Hct.fromInt(argbFromHex(hex));
  return { hue: h.hue, chroma: h.chroma, tone: h.tone };
}

/** The same colour at another HCT hue (the hue slider): its chroma kept, at least enough to show the hue. */
export function withHue(hex: string, hue: number): string {
  const { chroma, tone } = hctOf(hex);
  return seedFromHue(hue, Math.max(chroma, 24), Math.min(Math.max(tone, 25), 75));
}

/** The CSS gradient of HCT hues at one chroma and tone: the hue slider's track. */
export function hueTrack(chroma = 48, tone = 60): string {
  const stops = Array.from({ length: 13 }, (_, i) => `${hexFromArgb(Hct.from(i * 30, chroma, tone).toInt())} ${Math.round((i / 12) * 100)}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
