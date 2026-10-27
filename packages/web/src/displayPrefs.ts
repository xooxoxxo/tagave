import { useCallback, useSyncExternalStore } from 'react';

/**
 * Display preferences from Settings › Appearance: where the sidebar's search
 * sits, whether the "tagave" wordmark shows beside the mark, the
 * generative artwork under short albums, and how the artist page is laid out. Per-browser conveniences like the
 * theme, kept in localStorage; every access is guarded, and with storage
 * blocked the defaults (today's look) apply.
 */
export interface DisplayPrefs {
  /** 'below': the search pill on its own line under the logo; 'beside': on the logo's row. */
  searchPlacement: 'below' | 'beside';
  showWordmark: boolean;
  /** The ripple artwork under albums of five tracks or fewer, where the pane has room. */
  shortAlbumArt: boolean;
  /** The artist page: 'name' (the name first, notes in a column beside the albums) or 'albums' (laid out like an album page). */
  artistLayout: 'name' | 'albums';
  /**
   * The old Adaptive colours switch, from before themes: now only which
   * theme applies until the person picks one (on: Adaptive, off: Classic;
   * themes/themeChoice.ts). Settings no longer shows it.
   */
  adaptiveColour: boolean;
  /** A soft glow along the player's seek bar that moves with the music. */
  eqGlow: boolean;
}

export const DISPLAY_STORAGE_KEY = 'tagave-display';
export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = { searchPlacement: 'below', showWordmark: true, shortAlbumArt: true, artistLayout: 'name', adaptiveColour: true, eqGlow: false };

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
    artistLayout: stored['artistLayout'] === 'albums' ? 'albums' : 'name',
    adaptiveColour: typeof stored['adaptiveColour'] === 'boolean' ? stored['adaptiveColour'] : true,
    eqGlow: stored['eqGlow'] === true,
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
