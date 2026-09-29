import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * WCAG contrast of every ink-on-fill pair the primitives use, computed with
 * the WCAG 2.x relative-luminance formula for BOTH themes. The dark theme is
 * the light :root block overridden by the dark block.
 */
const css = readFileSync(new URL('../../styles/tokens.css', import.meta.url), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Missing block: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function declarations(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) map.set(match[1]!, match[2]!.trim());
  return map;
}

const lightBlock = block(':root {');
const darkMediaBlock = block(':root:not([data-theme="light"]) {');
const darkAttrBlock = block(':root[data-theme="dark"] {');
const light = declarations(lightBlock);
const dark = new Map([...light, ...declarations(darkAttrBlock)]);
const themes = { light, dark } as const;

function hex(theme: Map<string, string>, token: string, seen: string[] = []): string {
  const value = theme.get(token);
  if (!value) throw new Error(`Missing token --${token}`);
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const ref = value.match(/^var\(--([a-z0-9-]+)\)$/)?.[1];
  if (!ref || seen.includes(ref)) throw new Error(`--${token} is not a solid colour: ${value}`);
  return hex(theme, ref, [...seen, token]);
}

function channels(value: string): number[] {
  return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
}

function mix(a: string, b: string): string {
  const ca = channels(a), cb = channels(b);
  return '#' + ca.map((v, i) => Math.round((v + cb[i]!) / 2).toString(16).padStart(2, '0')).join('');
}

function luminance(value: string): number {
  const [r, g, b] = channels(value).map(v => v / 255).map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
}

function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A fill written as "a+b" is the midpoint of the two, e.g. the lower half of a drop's gradient. */
function fill(theme: Map<string, string>, spec: string): string {
  const [a, b] = spec.split('+');
  return b ? mix(hex(theme, a!), hex(theme, b)) : hex(theme, a!);
}

const textPairs: [ink: string, surface: string][] = [
  // body text on every surface
  ['ink', 'canvas'], ['ink', 'surface'], ['ink', 'mist'], ['ink', 'mist-2'],
  ['ink-2', 'canvas'], ['ink-2', 'surface'], ['ink-2', 'mist'], ['ink-2', 'dew-tint'],
  ['ink-3', 'canvas'], ['ink-3', 'surface'], ['ink-3', 'mist'],
  // links and the quiet button
  ['dew', 'canvas'], ['dew', 'surface'], ['dew', 'mist'], ['dew', 'dew-tint'],
  ['accent-hover', 'canvas'], ['accent-hover', 'surface'],
  // drop labels: the body colour and the lower half of the gradient
  ['dew-ink', 'dew'], ['dew-ink', 'dew+dew-lo'], ['dew-ink', 'dew-press'], ['dew-ink', 'accent-hover'],
  ['danger-ink', 'danger'], ['danger-ink', 'danger+danger-lo'],
  // chips, badges and banners
  ['chip-on-ink', 'dew-tint'], ['danger', 'surface'], ['danger', 'mist'], ['danger', 'danger-tint'],
  ['ok', 'ok-tint'], ['warn', 'warn-tint'], ['ok', 'surface'], ['warn', 'surface'],
  ['ink', 'ok-tint'], ['ink', 'warn-tint'], ['ink', 'danger-tint'], ['ink', 'dew-tint'],
  // legacy names still used by pages
  ['text-primary', 'bg-primary'], ['text-secondary', 'bg-tertiary'], ['text-tertiary', 'bg-secondary'],
  ['text-selected', 'surface-selected'], ['success', 'surface-success'], ['warning', 'surface-warning'],
  ['error', 'surface-danger'], ['info', 'surface-info'], ['accent', 'surface-accent'], ['on-accent', 'accent'],
];

const nonTextPairs: [mark: string, surface: string][] = [
  ['ring', 'canvas'], ['ring', 'surface'], ['ring', 'mist'],
  ['ok', 'canvas'], ['warn', 'canvas'], ['danger', 'canvas'], ['dew', 'canvas'],
  // focus indicator: the 2px --ring outline around a focused control, on every
  // surface a control sits on (including a selected row), and the invalid
  // variant, which swaps the outline colour to --danger
  ['ring', 'dew-tint'], ['ring', 'mist-2'], ['danger', 'surface'], ['danger', 'mist'],
  // the focused field's border
  ['dew', 'surface'],
];

/*
 * Resting control borders (--control-border = --line-strong) are deliberately
 * lighter than 3:1: a field is identified by its recessed fill, its label and
 * its placeholder, and the solid focus ring above carries the 3:1 guarantee.
 * This floor only stops the border from fading back into the hairlines.
 */
const controlBorderFloor = 1.5;

describe.each(Object.entries(themes))('%s theme', (_name, theme) => {
  it.each(textPairs)('%s on %s meets AA text contrast (4.5:1)', (ink, surface) => {
    expect(contrast(hex(theme, ink), fill(theme, surface))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(nonTextPairs)('%s on %s meets AA non-text contrast (3:1)', (mark, surface) => {
    expect(contrast(hex(theme, mark), fill(theme, surface))).toBeGreaterThanOrEqual(3);
  });
  it('control borders are stronger than hairlines and clear the floor', () => {
    const border = hex(theme, 'control-border');
    expect(border).toBe(hex(theme, 'line-strong'));
    expect(contrast(border, hex(theme, 'surface'))).toBeGreaterThan(contrast(hex(theme, 'line'), hex(theme, 'surface')));
    expect(contrast(border, hex(theme, 'surface'))).toBeGreaterThanOrEqual(controlBorderFloor);
  });
});

describe('theme structure', () => {
  it('declares the dark palette identically for the OS setting and the explicit choice', () => {
    expect(declarations(darkMediaBlock)).toEqual(declarations(darkAttrBlock));
  });
  it('gives every light colour token a dark value', () => {
    const darkOwn = declarations(darkAttrBlock);
    const colourTokens = [...light].filter(([, value]) => /^(#|rgba?\()/.test(value)).map(([token]) => token);
    expect(colourTokens.filter(token => !darkOwn.has(token))).toEqual([]);
  });
  it('matches the published WCAG examples', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#276a82')).toBeCloseTo(6.05, 2);
  });
});
