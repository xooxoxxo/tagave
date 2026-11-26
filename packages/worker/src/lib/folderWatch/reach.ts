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

const OFFLINE_CODES: Record<string, ReachReason> = {
  EIO: 'io_error',
  ETIMEDOUT: 'timeout',
  EHOSTDOWN: 'timeout',
  ESTALE: 'stale',
};

const ONLINE: Reading = { reach: 'online', reason: null };

export function classify(o: ProbeOutcome): Reading {
  switch (o.kind) {
    case 'server_silent':
      return { reach: 'offline', reason: 'server_silent' };
    case 'deadline':
      return { reach: 'offline', reason: 'timeout' };
    case 'error': {
      const reason = OFFLINE_CODES[o.code];
      if (reason) return { reach: 'offline', reason };
      if (o.code === 'ENOENT') return { reach: 'unmounted', reason: 'not_mounted' };
      // A probe that errored never listed anything, so any other code fails safe as offline.
      return { reach: 'offline', reason: 'io_error' };
    }
    case 'listing':
      // The share was mounted here and is not any more.
      if (o.wasMountPoint && !o.isMountPoint) return { reach: 'unmounted', reason: 'not_mounted' };
      // None of the files the library knows are there.
      if (o.knownAsked > 0 && o.knownFound === 0) return { reach: 'unmounted', reason: 'empty' };
      // Nothing known to ask about, and an empty plain folder where the music should be.
      if (o.knownAsked === 0 && o.empty && !o.isMountPoint) return { reach: 'unmounted', reason: 'empty' };
      return ONLINE;
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
