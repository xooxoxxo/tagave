/**
 * Library care › Identify: what "Identify now" and "Retry selected" did, and
 * what the waiting albums are doing, from the server's own state — the page
 * never sits on "Waiting for the worker" when nothing is queued or no worker
 * runs.
 */
import type { ApiError } from '../services/api';

/** A failed action in the server's words, or the fallback when nothing came back. */
export function actionProblem(err: unknown, fallback: string): string {
  const e = err as Partial<ApiError> | null | undefined;
  return e?.detail || e?.title || fallback;
}
