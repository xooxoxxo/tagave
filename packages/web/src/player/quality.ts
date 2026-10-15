/**
 * The per-device quality choice (Settings › Playback): kept in this
 * browser's localStorage, every access guarded; with storage blocked the
 * choice still applies for this page view. The engine and the settings page
 * read the same snapshot.
 */
import { PLAYER_QUALITY_STORAGE_KEY, type PlayerQuality } from '@liner/shared';
import { parseQuality, readQuality } from './logic';

const listeners = new Set<() => void>();
let current: PlayerQuality | undefined;

export function getPlayerQuality(): PlayerQuality {
  current ??= readQuality();
  return current;
}

export function setPlayerQuality(patch: Partial<PlayerQuality>): void {
  const next = { ...getPlayerQuality(), ...patch };
  try {
    globalThis.localStorage?.setItem(PLAYER_QUALITY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the choice applies for this page view
  }
  current = next;
  listeners.forEach((l) => l());
}

export function subscribePlayerQuality(listener: () => void): () => void {
  listeners.add(listener);
  // another tab changed it
  const onStorage = (e: StorageEvent) => {
    if (e.key !== PLAYER_QUALITY_STORAGE_KEY) return;
    current = parseQuality(e.newValue);
    listener();
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}
