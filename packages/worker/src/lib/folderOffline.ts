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
  /** The share's error code (EIO, ESTALE, ...) when the share answered with one; none on a deadline. */
  readonly code?: string;

  constructor(scanRootId: string, reason: ReachReason, code?: string) {
    super(`The music folder is offline (${reason})`);
    this.scanRootId = scanRootId;
    this.reason = reason;
    if (code !== undefined) this.code = code;
  }
}

/**
 * The error codes that mean the share is gone, not that one file is bad.
 * Keep in step with the code-to-reason table in folderWatch/reach.ts (OFFLINE_CODES there).
 */
export const OFFLINE_CODES = new Set(['EIO', 'ETIMEDOUT', 'ESTALE', 'EHOSTDOWN', 'ENOTCONN']);

/**
 * The codes that mean "no such path": a file or folder that is not there
 * (another spelling may be). Anything else from a file call is not proof
 * that a path is absent.
 */
export const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR', 'EILSEQ', 'ENAMETOOLONG']);

/** The gate's own failures, not the share's: a helper that failed (EHELPER), the gate shut down (EGATECLOSED). */
export const GATE_FAILURE_CODES = new Set(['EHELPER', 'EGATECLOSED']);

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The path is not there (ENOENT and its kin). */
export function isAbsent(err: unknown): boolean {
  const code = codeOf(err);
  return code !== undefined && ABSENT_CODES.has(code);
}

/** The gate failed, so nothing is known about the path: never read it as absent, unreadable or bad. */
export function isGateFailure(err: unknown): boolean {
  const code = codeOf(err);
  return code !== undefined && GATE_FAILURE_CODES.has(code);
}

/** The gate shut down (the worker is stopping): no answer about the path at all. */
export function isGateClosed(err: unknown): boolean {
  return codeOf(err) === 'EGATECLOSED';
}

/** A FolderOfflineError, or an error whose `code` is an offline code. */
export function isOfflineError(err: unknown): boolean {
  if (err instanceof FolderOfflineError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && OFFLINE_CODES.has(code);
}
