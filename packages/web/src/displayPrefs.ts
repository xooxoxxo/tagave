import { useCallback, useSyncExternalStore } from 'react';

/**
 * Display preferences from Settings › Appearance: where the sidebar's search
 * sits, whether the "tagave" wordmark shows beside the mark, and the
 * generative artwork under short albums. Per-browser conveniences like the
 * theme, kept in localStorage; every access is guarded, and with storage
 * blocked the defaults (today's look) apply.
 */
export interface DisplayPrefs {
  /** 'below': the search pill on its own line under the logo; 'beside': on the logo's row. */
  searchPlacement: 'below' | 'beside';
  showWordmark: boolean;
  /** The ripple artwork under albums of three tracks or fewer. */
  shortAlbumArt: boolean;
}

export const DISPLAY_STORAGE_KEY = 'tagave-display';
export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = { searchPlacement: 'below', showWordmark: true, shortAlbumArt: true };

/** Reads what is stored, keeping only valid values; anything else falls back to the default. */
export function parseDisplayPrefs(raw: string | null | undefined): DisplayPrefs {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>;
  } catch { /* corrupt: defaults */ }
  return {
    searchPlacement: stored['searchPlacement'] === 'beside' ? 'beside' : 'below',
    showWordmark: typeof stored['showWordmark'] === 'boolean' ? stored['showWordmark'] : true,
    shortAlbumArt: typeof stored['shortAlbumArt'] === 'boolean' ? stored['shortAlbumArt'] : true,
  };
}

function read(): DisplayPrefs {
  try {
    return parseDisplayPrefs(globalThis.localStorage?.getItem(DISPLAY_STORAGE_KEY));
  } catch {
    return DEFAULT_DISPLAY_PREFS;
  }
}

const listeners = new Set<() => void>();
let current: DisplayPrefs | undefined;

export function setDisplayPrefs(patch: Partial<DisplayPrefs>): void {
  const next = { ...snapshot(), ...patch };
  try {
    globalThis.localStorage?.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the choice still applies for this page view.
  }
  current = next;
  listeners.forEach((l) => l());
}

function snapshot(): DisplayPrefs {
  current ??= read();
  return current;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  // another tab changed a preference
  const onStorage = (e: StorageEvent) => {
    if (e.key !== DISPLAY_STORAGE_KEY) return;
    current = parseDisplayPrefs(e.newValue);
    listener();
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}

/** The display preferences plus a setter that merges a change; subscribers re-render on change. */
export function useDisplayPrefs(): [DisplayPrefs, (patch: Partial<DisplayPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_DISPLAY_PREFS);
  const set = useCallback((patch: Partial<DisplayPrefs>) => setDisplayPrefs(patch), []);
  return [prefs, set];
}
