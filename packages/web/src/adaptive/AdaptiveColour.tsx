/**
 * Adaptive colour, the controller (mounted once in Layout): while a queue
 * with a cover plays and Settings › Appearance › Adaptive colours is on, the
 * cover's scheme (scheme.ts, loaded on first use) is written to the --ad-*
 * properties on <html> and data-adaptive turns the theme over to them
 * (styles/adaptive.css). A cover with no usable colour, the setting off or
 * the queue closed fades back to the brand values, then lets go.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useDisplayPrefs } from '../displayPrefs';
import { useThemePreference } from '../theme';
import { currentTrack, usePlayerStore } from '../player/engine';
import { BRAND_TOKENS } from './brand';

type SchemeModule = typeof import('./scheme');
let schemeModule: SchemeModule | null = null;
let loading: Promise<SchemeModule> | null = null;
function loadScheme(): Promise<SchemeModule> {
  loading ??= import('./scheme').then((m) => (schemeModule = m));
  return loading;
}

/** Side of the canvas a cover is drawn into before its pixels are read. */
const SAMPLE = 64;
type Colours = import('./scheme').CoverColours;
const sources = new Map<string, Promise<Colours | null>>();

/**
 * The colours of a cover URL, or null (the cover did not load). Covers are
 * same-origin (/api/v1/images/album/:id), so the canvas can be read. Cached
 * per URL for the page's life.
 */
export function coverSource(url: string): Promise<Colours | null> {
  let hit = sources.get(url);
  if (!hit) {
    hit = Promise.all([loadScheme(), loadImage(url)]).then(([mod, img]) => {
      performance.mark('adaptive-extract-start');
      const canvas = document.createElement('canvas');
      canvas.width = SAMPLE;
      canvas.height = SAMPLE;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      if (!g) return null;
      g.drawImage(img, 0, 0, SAMPLE, SAMPLE);
      const colours = mod.coverColours(g.getImageData(0, 0, SAMPLE, SAMPLE).data);
      performance.measure('adaptive-extract', 'adaptive-extract-start');
      return colours;
    }).catch(() => null);
    sources.set(url, hit);
  }
  return hit;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('cover did not load'));
    img.src = url;
  });
}

const darkQuery = '(prefers-color-scheme: dark)';
function subscribeDark(cb: () => void) {
  const mq = globalThis.matchMedia?.(darkQuery);
  mq?.addEventListener('change', cb);
  return () => mq?.removeEventListener('change', cb);
}
/** Whether the dark palette is in effect: the explicit choice, else the OS. */
export function useResolvedDark(): boolean {
  const [preference] = useThemePreference();
  const osDark = useSyncExternalStore(subscribeDark, () => !!globalThis.matchMedia?.(darkQuery).matches, () => false);
  return preference === 'dark' || (preference === 'system' && osDark);
}

const FADE_MS = 600;
let release: ReturnType<typeof setTimeout> | null = null;
let lastDark: boolean | null = null;

function write(root: HTMLElement, tokens: Record<string, string>) {
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
}

/** Writes without the fade: a theme switch flips text and surfaces across, and a fade would cross them mid-way. */
function writeNow(root: HTMLElement, tokens: Record<string, string>) {
  root.style.setProperty('transition', 'none');
  write(root, tokens);
  void getComputedStyle(root).getPropertyValue('--ad-accent');
  root.style.removeProperty('transition');
}

/** Applies a scheme (or, with null, fades back to the brand and lets go). */
export function applyAdaptive(tokens: Record<string, string> | null, dark: boolean, root: HTMLElement = document.documentElement) {
  const brand = BRAND_TOKENS[dark ? 'dark' : 'light'];
  const themeChanged = lastDark !== null && lastDark !== dark;
  lastDark = dark;
  if (tokens) {
    if (release) { clearTimeout(release); release = null; }
    if (root.dataset['adaptive'] === undefined) {
      // start from the brand values of this theme, not the properties' initial values
      root.dataset['adaptive'] = '';
      writeNow(root, brand);
    }
    if (themeChanged) writeNow(root, tokens);
    else write(root, tokens);
    return;
  }
  if (root.dataset['adaptive'] === undefined) return;
  if (themeChanged) writeNow(root, brand);
  if (release) return;
  write(root, brand);
  const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  release = setTimeout(() => {
    release = null;
    delete root.dataset['adaptive'];
    for (const k of Object.keys(brand)) root.style.removeProperty(k);
  }, reduce ? 0 : FADE_MS + 50);
}

export function AdaptiveColour() {
  const [prefs] = useDisplayPrefs();
  // the playing track's cover: a playlist's tracks each bring their own album's
  const cover = usePlayerStore((s) => (currentTrack(s) ?? s.queue?.tracks[0])?.coverUrl ?? null);
  const dark = useResolvedDark();
  const [source, setSource] = useState<{ url: string; colours: Colours | null } | null>(null);
  const on = prefs.adaptiveColour && !!cover;

  useEffect(() => {
    if (!on || !cover) return;
    let live = true;
    void coverSource(cover).then((colours) => { if (live) setSource({ url: cover, colours }); });
    return () => { live = false; };
  }, [on, cover]);

  const colours = on && source?.url === cover ? source.colours : null;
  // while a new cover is being read, the current colours stay
  const pending = on && source?.url !== cover;
  useEffect(() => {
    if (pending) return;
    applyAdaptive(colours?.source != null && schemeModule ? schemeModule.adaptiveTokens(colours.source, dark, colours) : null, dark);
  }, [colours, dark, pending]);

  useEffect(() => () => applyAdaptive(null, dark), []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
