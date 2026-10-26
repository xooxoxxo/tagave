/**
 * Library care › Identify: what "Identify now" and "Retry selected" did, and
 * what the waiting albums are doing, from the server's own state — the page
 * never sits on "Waiting for the worker" when nothing is queued or no worker
 * runs.
 */
import type { ApiError } from '../services/api';
import { formatEta } from '../utils/time';

/** A failed action in the server's words, or the fallback when nothing came back. */
export function actionProblem(err: unknown, fallback: string): string {
  const e = err as Partial<ApiError> | null | undefined;
  return e?.detail || e?.title || fallback;
}

/** What POST /identify/sweep did; null for an older server ({ ok: true }). */
export function identifyNowNote(result: unknown): string | null {
  const r = result as { waiting?: unknown; enqueued?: unknown } | null | undefined;
  if (typeof r?.waiting !== 'number' || typeof r.enqueued !== 'number') return null;
  if (r.waiting === 0) return 'Nothing to identify';
  if (r.enqueued === 0) return 'Already queued';
  return `${r.enqueued.toLocaleString()} ${r.enqueued === 1 ? 'album' : 'albums'} queued`;
}

export interface ProgressInput {
  perMin: number;
  etaSeconds: number | null;
  queue: { queued: number; active: number; retry: number };
  /** undefined when the worker heartbeat is not known (not an owner, still loading) */
  workerLive: boolean | undefined;
}

/** The line under "N albums waiting". */
export function identifyProgressLine({ perMin, etaSeconds, queue, workerLive }: ProgressInput): string {
  if (perMin > 0 && etaSeconds) return `${perMin.toLocaleString()}/min · ${formatEta(etaSeconds)} left`;
  if (queue.active > 0) return 'Working';
  if (queue.queued + queue.retry === 0) return 'Nothing queued';
  return workerLive === false ? 'No worker is running' : 'Waiting for the worker';
}
