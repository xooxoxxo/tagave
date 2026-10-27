/**
 * The cover behind Now Playing (NowPlaying.module.css .wash: the cover,
 * blurred and saturated, over the canvas). How strongly it shows is worked
 * out per cover, so the text over it reads at AA whatever the cover, with
 * adaptive colours on or off: the most opacity (up to 0.45 with adaptive
 * colours, 0.3 without) at which the theme's three inks reach 4.7:1 (a margin
 * over 4.5 for the blur's edges) and the accent 3.2:1 on the cover's darkest
 * and lightest pixel, saturated as the wash paints them, laid over the canvas
 * in effect. The blur only averages pixels, so these are the worst case.
 *
 * No colour library here: this module is in the main bundle.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { BRAND_TOKENS } from './brand';

/** The theme's inks (tokens.css): --ink, --ink-2, --ink-3, as ARGB. Adaptive colours never replace them on the page. */
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
export const argbOfHex = (hex: string) => (0xff000000 | parseInt(hex.trim().slice(1, 7), 16)) >>> 0;

/** The CSS filter saturate(1.2) the wash applies, on an ARGB colour as the browser paints it. */
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

export interface Extremes { darkest: number; lightest: number }

/** The darkest and lightest opaque pixel of RGBA pixels, as ARGB. */
export function extremes(rgba: ArrayLike<number>): Extremes {
  let darkest = 0xff808080, lightest = 0xff808080, dl = Infinity, ll = -Infinity;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 255) continue;
    const y = 0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!;
    const argb = (0xff000000 | (rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!) >>> 0;
    if (y < dl) { dl = y; darkest = argb; }
    if (y > ll) { ll = y; lightest = argb; }
  }
  return { darkest, lightest };
}

export const WASH_MAX = { adaptive: 0.45, brand: 0.3 } as const;

/** The opacity the wash may take over this canvas with this accent (see the top of this file). */
export function washOpacity(canvas: number, accent: number, e: Extremes, dark: boolean, max: number): number {
  const inks = THEME_INKS[dark ? 'dark' : 'light'];
  const px = [e.darkest, e.lightest].map((p) => saturate(p));
  for (let a = max; a > 0; a = Math.round((a - 0.01) * 100) / 100) {
    const bgs = px.map((p) => overArgb(p, a, canvas));
    if (bgs.every((bg) => inks.every((ink) => contrastOf(ink, bg) >= 4.7) && contrastOf(accent, bg) >= 3.2)) return a;
  }
  return 0;
}

/** Side of the canvas a cover is drawn into before its pixels are read. */
export const SAMPLE = 64;
const samples = new Map<string, Promise<Uint8ClampedArray | null>>();

/**
 * A cover's pixels at 64 × 64, or null (it did not load, or the canvas cannot
 * be read). Covers are same-origin (/api/v1/images/album/:id). Cached per URL.
 */
export function sampleCover(url: string): Promise<Uint8ClampedArray | null> {
  let hit = samples.get(url);
  if (!hit) {
    hit = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('cover did not load'));
      img.src = url;
    }).then((img) => {
      const canvas = document.createElement('canvas');
      canvas.width = SAMPLE;
      canvas.height = SAMPLE;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      if (!g) return null;
      g.drawImage(img, 0, 0, SAMPLE, SAMPLE);
      return g.getImageData(0, 0, SAMPLE, SAMPLE).data;
    }).catch(() => null);
    samples.set(url, hit);
  }
  return hit;
}

/** What the wash lies on now: theme, and the canvas and accent in effect (the cover's, or the brand's). */
function readSurface(): string {
  const root = globalThis.document?.documentElement;
  if (!root) return 'light|#f6f8fa|#276a82|brand';
  const theme = root.getAttribute('data-theme');
  const dark = theme === 'dark' || (theme !== 'light' && !!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const brand = BRAND_TOKENS[dark ? 'dark' : 'light'];
  const adaptive = root.dataset['adaptive'] !== undefined && !!root.style.getPropertyValue('--ad-canvas');
  // the values written, not the computed ones: those may be half-way through the 600 ms fade
  const canvas = adaptive ? root.style.getPropertyValue('--ad-canvas').trim() : brand['--ad-canvas']!;
  const accent = adaptive ? root.style.getPropertyValue('--ad-accent').trim() : brand['--ad-accent']!;
  return `${dark ? 'dark' : 'light'}|${canvas}|${accent}|${adaptive ? 'adaptive' : 'brand'}`;
}
function subscribeSurface(cb: () => void) {
  const root = globalThis.document?.documentElement;
  const mo = root && typeof MutationObserver !== 'undefined' ? new MutationObserver(cb) : null;
  if (root) mo?.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-adaptive', 'style'] });
  const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener('change', cb);
  return () => { mo?.disconnect(); mq?.removeEventListener('change', cb); };
}

/** The opacity of Now Playing's wash for this cover: 0 until its pixels are read. */
export function useWashOpacity(url: string | null): number {
  const [read, setRead] = useState<{ url: string; e: Extremes } | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    void sampleCover(url).then((px) => { if (live && px) setRead({ url, e: extremes(px) }); });
    return () => { live = false; };
  }, [url]);
  const surface = useSyncExternalStore(subscribeSurface, readSurface, () => 'light|#f6f8fa|#276a82|brand');
  if (!url || !read || read.url !== url) return 0;
  const [theme, canvas, accent, mode] = surface.split('|') as [string, string, string, 'adaptive' | 'brand'];
  return washOpacity(argbOfHex(canvas), argbOfHex(accent), read.e, theme === 'dark', WASH_MAX[mode]);
}
