import { useCallback, useSyncExternalStore } from 'react';

/**
 * Maintenance: the app-wide mode that reveals curation UI (album state,
 * provider links, library issues, the Manage menu, quality flags on covers).
 * Off by default: the app is for listening and browsing, and a page only
 * interrupts when a real discrepancy needs a decision.
 *
 * Remembered per browser in localStorage (a per-viewer convenience, like the
 * theme); every access is guarded, and with storage blocked the mode simply
 * starts off on each visit.
 */
export const MAINTENANCE_STORAGE_KEY = 'tagave-maintenance';

const listeners = new Set<() => void>();
let current: boolean | undefined;

export function readMaintenance(): boolean {
  try {
    return globalThis.localStorage?.getItem(MAINTENANCE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMaintenance(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(MAINTENANCE_STORAGE_KEY, '1');
    else globalThis.localStorage?.removeItem(MAINTENANCE_STORAGE_KEY);
  } catch {
    // Storage unavailable: the mode still applies for this page view.
  }
  current = on;
  listeners.forEach((l) => l());
}

export function toggleMaintenance(): void {
  setMaintenance(!snapshot());
}

function snapshot(): boolean {
  current ??= readMaintenance();
  return current;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  // another tab switched the mode
  const onStorage = (e: StorageEvent) => {
    if (e.key !== MAINTENANCE_STORAGE_KEY) return;
    current = e.newValue === '1';
    listener();
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}

/** Whether Maintenance is on, plus a setter; every subscriber re-renders on change. */
export function useMaintenance(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, snapshot, () => false);
  const set = useCallback((next: boolean) => setMaintenance(next), []);
  return [on, set];
}

/** The keyboard shortcut: Shift+M outside text fields. */
export function isMaintenanceShortcut(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>, target: EventTarget | null): boolean {
  if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key !== 'M' && e.key !== 'm') return false;
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return false;
  return true;
}
