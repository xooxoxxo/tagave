/**
 * Music folder reach (0097, vault "tagave - Offline Library Spec" §3): what
 * the folder watch last saw on a root. `unknown` is a root with no reading
 * yet, which reads as "Checking". The reason is a fixed code, never host text.
 */
export const REACH_VALUES = ['unknown', 'online', 'offline', 'unmounted'] as const;
export type Reach = (typeof REACH_VALUES)[number];

export const REACH_REASONS = ['server_silent', 'timeout', 'io_error', 'stale', 'empty', 'not_mounted'] as const;
export type ReachReason = (typeof REACH_REASONS)[number];

/** Work that waits for a music folder to come back (parked_jobs), by kind. */
export interface WaitingCounts {
  scans: number;
  tagWrites: number;
  other: number;
}

/** One music folder that is offline or not connected, as the owner's notice shows it. */
export interface MusicFolderView {
  id: string;
  name: string;
  path: string;
  reach: Reach;
  /** ISO 8601, when reach last changed; null with no reading yet */
  since: string | null;
  reason: ReachReason | null;
  waiting: WaitingCounts;
}

/** `unreachable`: what an API older than 0097 answered; kept for one release. */
export type MusicFolderNoticeKind = 'none' | 'healing' | 'offline' | 'unreachable';

/** GET /api/v1/system/music-folder (owner only). */
export interface MusicFolderResponse {
  kind: MusicFolderNoticeKind;
  /** empty with kind none or healing */
  folders: MusicFolderView[];
  /** one release: the old web build reads it */
  paths?: string[];
}
