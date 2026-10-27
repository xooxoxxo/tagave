import { useCallback, useSyncExternalStore } from 'react';
import { themeChoiceSchema, type ThemeChoice } from '@tagave/shared';
import { DISPLAY_STORAGE_KEY, parseDisplayPrefs } from '../displayPrefs';

/**
 * The colour theme (Settings › Appearance). The person's choice lives on the
 * server (GET/PUT /api/v1/me/prefs, user_prefs) so it follows them between
 * devices; this browser keeps a copy, and the tokens it generates for both
 * modes, so the first paint is already themed (index.html applies them
 * before the app loads). Every storage access is guarded: with storage
 * blocked the choice still applies for the page view.
 *
 * Until the person picks a theme the choice follows this browser's old
 * Adaptive colours switch (displayPrefs.adaptiveColour): on (the default) is
 * Adaptive, off is Classic, so nobody's look changes.
 */
export const THEME_CHOICE_KEY = 'tagave-theme-choice';
/** { light: tokens, dark: tokens } of a generated theme; absent for the brand tokens. index.html reads it. */
export const THEME_TOKENS_KEY = 'tagave-theme-tokens';

export type ThemeTokens = { light: Record<string, string>; dark: Record<string, string> };

/** The choice before the person makes one. */
export function defaultChoice(): ThemeChoice {
  let adaptive = true;
  try {
    adaptive = parseDisplayPrefs(globalThis.localStorage?.getItem(DISPLAY_STORAGE_KEY)).adaptiveColour;
  } catch { /* storage blocked: the default */ }
  return { theme: adaptive ? 'adaptive' : 'classic', custom: null };
}

/** A stored copy, if it is one. */
export function parseChoice(raw: string | null | undefined): ThemeChoice | null {
  if (!raw) return null;
  try {
    const parsed = themeChoiceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function read(): ThemeChoice {
  try {
    return parseChoice(globalThis.localStorage?.getItem(THEME_CHOICE_KEY)) ?? defaultChoice();
  } catch {
    return defaultChoice();
  }
}

const listeners = new Set<() => void>();
let current: ThemeChoice | undefined;

function snapshot(): ThemeChoice {
  current ??= read();
  return current;
}

export const sameChoice = (a: ThemeChoice, b: ThemeChoice) => JSON.stringify(a) === JSON.stringify(b);

/** Sets the choice on this browser (the caller saves it to the server). */
export function setThemeChoice(next: ThemeChoice): void {
  if (current && sameChoice(current, next)) return;
  try {
    globalThis.localStorage?.setItem(THEME_CHOICE_KEY, JSON.stringify(next));
  } catch { /* storage unavailable: it still applies for this page view */ }
  current = next;
  listeners.forEach((l) => l());
}

/** The tokens the next page load paints with (null: the brand tokens). */
export function cacheThemeTokens(tokens: ThemeTokens | null): void {
  try {
    if (tokens) globalThis.localStorage?.setItem(THEME_TOKENS_KEY, JSON.stringify(tokens));
    else globalThis.localStorage?.removeItem(THEME_TOKENS_KEY);
  } catch { /* storage unavailable */ }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // another tab changed it
  const onStorage = (e: StorageEvent) => {
    if (e.key !== THEME_CHOICE_KEY) return;
    current = parseChoice(e.newValue) ?? defaultChoice();
    listener();
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}

/** The colour theme on this browser; re-renders on change. */
export function useThemeChoiceValue(): ThemeChoice {
  return useSyncExternalStore(subscribe, snapshot, defaultChoice);
}

/** For tests: forget the in-memory copy. */
export function resetThemeChoiceForTests(): void {
  current = undefined;
}

/**
 * The properties a theme set on <html>: this module's, and those index.html
 * set from the cache before it loaded (the same names, read back from it).
 */
const applied = new Set<string>();
function cachedKeys(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(THEME_TOKENS_KEY);
    const t = raw ? (JSON.parse(raw) as Partial<ThemeTokens>) : null;
    return [...Object.keys(t?.light ?? {}), ...Object.keys(t?.dark ?? {})];
  } catch {
    return [];
  }
}

/** Applies a theme's tokens on <html> (null: takes them off, back to the brand tokens). Call before cacheThemeTokens. */
export function applyThemeTokens(tokens: Record<string, string> | null, root: HTMLElement | undefined = globalThis.document?.documentElement): void {
  if (!root) return;
  if (root.dataset['themed'] !== undefined) for (const k of cachedKeys()) applied.add(k);
  for (const k of applied) if (!tokens || !(k in tokens)) root.style.removeProperty(k);
  applied.clear();
  if (!tokens) {
    delete root.dataset['themed'];
    return;
  }
  for (const [k, v] of Object.entries(tokens)) {
    root.style.setProperty(k, v);
    applied.add(k);
  }
  root.dataset['themed'] = '';
}

/** The setter, for components that want a hook. */
export function useSetThemeChoice(): (next: ThemeChoice) => void {
  return useCallback((next: ThemeChoice) => setThemeChoice(next), []);
}
