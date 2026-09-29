import { useCallback, useSyncExternalStore } from 'react';

/**
 * Colour theme preference. "system" follows prefers-color-scheme; "light" and
 * "dark" pin the theme through data-theme on <html>, which tokens.css reads.
 * The choice is a per-browser convenience kept in localStorage; every access
 * is guarded because storage can be blocked (private windows, strict
 * settings), and the app then simply follows the OS.
 */
export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'tagave-theme';
const listeners = new Set<() => void>();

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readThemePreference(): ThemePreference {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(preference: ThemePreference, root: HTMLElement | undefined = globalThis.document?.documentElement): void {
  if (!root) return;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') globalThis.localStorage?.removeItem(THEME_STORAGE_KEY);
    else globalThis.localStorage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage unavailable: the choice still applies for this page view.
  }
  applyTheme(preference);
  current = preference;
  listeners.forEach(listener => listener());
}

let current: ThemePreference | undefined;
function snapshot(): ThemePreference {
  current ??= readThemePreference();
  return current;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Current preference plus a setter; every subscriber re-renders on change. */
export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const preference = useSyncExternalStore(subscribe, snapshot, () => 'system' as const);
  const set = useCallback((next: ThemePreference) => setThemePreference(next), []);
  return [preference, set];
}
