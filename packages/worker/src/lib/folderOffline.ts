/**
 * The error a music-share file call throws when the music folder is offline
 * (vault "tagave - Offline Library Spec"): the file gate gave up on it at a
 * deadline, or the share answered with an offline error code. Callers park
 * the work instead of failing it, and mark nothing missing.
 */
import type { ReachReason } from '@tagave/shared';

export class FolderOfflineError extends Error {
  override readonly name = 'FolderOfflineError';
  readonly scanRootId: string;
  readonly reason: ReachReason;

  constructor(scanRootId: string, reason: ReachReason) {
    super(`The music folder is offline (${reason})`);
    this.scanRootId = scanRootId;
    this.reason = reason;
  }
}

/** The error codes that mean the share is gone, not that one file is bad. */
export const OFFLINE_CODES = new Set(['EIO', 'ETIMEDOUT', 'ESTALE', 'EHOSTDOWN', 'ENOTCONN']);

/** A FolderOfflineError, or an error whose `code` is an offline code. */
export function isOfflineError(err: unknown): boolean {
  if (err instanceof FolderOfflineError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && OFFLINE_CODES.has(code);
}
