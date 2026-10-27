/**
 * Adaptive colour, the controller (mounted once in Layout): while a queue
 * with a cover plays and the theme is Adaptive (Settings › Appearance), the
 * cover's scheme (scheme.ts, loaded on first use) is written to the --ad-*
 * properties on <html> and data-adaptive turns the theme over to them
 * (styles/adaptive.css). A cover with no usable colour, another theme or
 * the queue closed fades back to the brand values, then lets go.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useThemeChoiceValue } from '../themes/themeChoice';
import { useThemePreference } from '../theme';
import { currentTrack, usePlayerStore } from '../player/engine';
import { BRAND_TOKENS } from './brand';
import { sampleCover } from './wash';

type SchemeModule = typeof import('./scheme');
let schemeModule: SchemeModule | null = null;
let loading: Promise<SchemeModule> | null = null;
function loadScheme(): Promise<SchemeModule> {
  loading ??= import('./scheme').then((m) => (schemeModule = m));
  return loading;
}

const sources = new Map<string, Promise<number | null>>();

/**
 * The source colour of a cover URL, or null (no usable colour, or the cover
 * did not load). Cached per URL for the page's life.
 */
export function coverSource(url: string): Promise<number | null> {
  let hit = sources.get(url);
  if (!hit) {
    hit = Promise.all([loadScheme(), sampleCover(url)]).then(([mod, px]) => {
      if (!px) return null;
      performance.mark('adaptive-extract-start');
      const source = mod.sourceColour(px);
      performance.measure('adaptive-extract', 'adaptive-extract-start');
      return source;
    }).catch(() => null);
    sources.set(url, hit);
  }
  return hit;
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
  const adaptive = useThemeChoiceValue().theme === 'adaptive';
  // the playing track's cover: a playlist's tracks each bring their own album's
  const cover = usePlayerStore((s) => (currentTrack(s) ?? s.queue?.tracks[0])?.coverUrl ?? null);
  const dark = useResolvedDark();
  const [source, setSource] = useState<{ url: string; argb: number | null } | null>(null);
  const on = adaptive && !!cover;

  useEffect(() => {
    if (!on || !cover) return;
    let live = true;
    void coverSource(cover).then((argb) => { if (live) setSource({ url: cover, argb }); });
    return () => { live = false; };
  }, [on, cover]);

  const argb = on && source?.url === cover ? source.argb : null;
  // while a new cover is being read, the current colours stay
  const pending = on && source?.url !== cover;
  useEffect(() => {
    if (pending) return;
    applyAdaptive(argb !== null && schemeModule ? schemeModule.adaptiveTokens(argb, dark) : null, dark);
  }, [argb, dark, pending]);

  useEffect(() => () => applyAdaptive(null, dark), []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
