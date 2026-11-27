/**
 * The reach rules for a music root (vault "tagave - Offline Library Spec"):
 * `classify` turns one probe into a reading, `nextReach` turns readings into
 * the status the folder shows. Pure: no disk, no clock, no database.
 */
import type { Reach, ReachReason } from '@tagave/shared';

/** What one probe of a root saw. */
export type ProbeOutcome =
  | { kind: 'server_silent' }
  | { kind: 'error'; code: string }
  | { kind: 'deadline' }
  | { kind: 'listing'; empty: boolean; knownFound: number; knownAsked: number; isMountPoint: boolean; wasMountPoint: boolean };

/** One probe's verdict. The reason is null only when the root is online. */
export interface Reading {
  reach: 'online' | 'offline' | 'unmounted';
  reason: ReachReason | null;
}

const OFFLINE_CODES = new Map<string, ReachReason>([
  ['EIO', 'io_error'],
  ['ETIMEDOUT', 'timeout'],
  ['EHOSTDOWN', 'timeout'],
  ['ESTALE', 'stale'],
]);

const ONLINE: Reading = { reach: 'online', reason: null };

/**
 * A root reads unmounted only from a listing that found none of the files the
 * library knows, with the root empty or no longer the mount point it was
 * ("No known file found, with an empty root or no longer a mount point where
 * it was one"). Unmounted asks the updater to remount and restart the music
 * parts, so every other case stays away from it: an error (a missing root
 * too) reads offline, a root with no known files to ask about never reads
 * unmounted, and a listing that is not empty and keeps its mount point reads
 * online even when the sampled files are gone (renamed or deleted files are
 * the scan's business, not a lost share).
 */
export function classify(o: ProbeOutcome): Reading {
  switch (o.kind) {
    case 'server_silent':
      return { reach: 'offline', reason: 'server_silent' };
    case 'deadline':
      return { reach: 'offline', reason: 'timeout' };
    case 'error':
      // A probe that errored never listed anything: offline, never unmounted. A missing root
      // (ENOENT: renamed or deleted) and any code not listed read io_error.
      return { reach: 'offline', reason: OFFLINE_CODES.get(o.code) ?? 'io_error' };
    case 'listing': {
      if (o.knownAsked === 0 || o.knownFound > 0) return ONLINE;
      // The share was mounted here and is not any more.
      if (o.wasMountPoint && !o.isMountPoint) return { reach: 'unmounted', reason: 'not_mounted' };
      // None of the known files, and an empty folder where the music should be.
      if (o.empty) return { reach: 'unmounted', reason: 'empty' };
      return ONLINE;
    }
  }
}

export interface ReachState {
  reach: Reach;
  /** When `reach` last changed; null while it is `unknown`. */
  since: Date | null;
  /** The first bad reading while online, waiting for a second one in a row. */
  pendingOffline: Reading | null;
}

/**
 * Leaving online takes two bad readings in a row; one good reading brings it
 * back. A root with no status yet (`unknown`) takes its first reading at
 * once, and offline and unmounted swap at once. `since` moves only when
 * `reach` does.
 */
export function nextReach(prev: ReachState, r: Reading, now: Date): { state: ReachState; changed: boolean } {
  if (prev.reach === r.reach) return { state: { ...prev, pendingOffline: null }, changed: false };
  if (prev.reach === 'online' && prev.pendingOffline === null) return { state: { ...prev, pendingOffline: r }, changed: false };
  return { state: { reach: r.reach, since: now, pendingOffline: null }, changed: true };
}
