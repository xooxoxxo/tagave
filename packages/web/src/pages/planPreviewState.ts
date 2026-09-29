/**
 * What the plan page says about a draft's preview, derived from the job the
 * API reports and what this page has asked for. Pure, so every state the
 * banner and the button can be in is testable without rendering the page.
 */
import type { TagPlanPreviewJob } from '@liner/shared';

export interface PreviewInput {
  /** The newest preview job for the plan, as GET /tag-plans/:id reports it. */
  job: TagPlanPreviewJob | undefined;
  /** Job id POST /preview returned for this page's own request, if it made one. */
  requestedJobId: string | undefined;
  /** The POST /preview call is in flight. */
  requestPending: boolean;
  /** This page asked for a preview and has not seen it finish. */
  requested: boolean;
  /** The request is older than the page's wait (30 s) without a running job. */
  timedOut: boolean;
  /** The job is running but its progress has not moved for the stale window. */
  runningStale: boolean;
  /** The plan already has preview results. */
  previewed: boolean;
}

export type StallReason = 'queued' | 'no-report' | 'no-progress';

export interface PreviewState {
  /** The job the page should describe; an older run is ignored once the page has asked for a new one. */
  current: TagPlanPreviewJob | undefined;
  failed: boolean;
  stalled: StallReason | null;
  busy: boolean;
  buttonLabel: string;
}

export function derivePreviewState(i: PreviewInput): PreviewState {
  // Only the job this page asked for counts once it has asked: an older
  // failed run must not paint a fresh request as failed.
  const current = i.job && (!i.requestedJobId || i.job.jobId === i.requestedJobId) ? i.job : undefined;
  const failed = !i.requestPending && current?.state === 'failed';

  // A running job that keeps reporting progress is slow, not stuck. The
  // warning is for a request nobody picked up, and for a running job that
  // went quiet (a worker that died mid-run stays "active" until it expires).
  let stalled: StallReason | null = null;
  if (!failed && !i.requestPending) {
    if (current?.state === 'running') {
      if (i.runningStale) stalled = 'no-progress';
    } else if (i.timedOut && current?.state !== 'completed') {
      stalled = current?.state === 'queued' ? 'queued' : 'no-report';
    }
  }

  const busy = i.requestPending
    || (!stalled && !failed && (i.requested || current?.state === 'queued' || current?.state === 'running'));
  const buttonLabel = busy ? 'Previewing…'
    : stalled || failed ? 'Retry preview'
      : i.previewed ? 'Re-run preview' : 'Run preview';

  return { current, failed, stalled, busy, buttonLabel };
}

/**
 * Whether the plan page offers Run / Re-run preview. The API previews a
 * draft, and re-previews a previewed plan (it goes back to draft first).
 * Applied, cancelled or reverted plans keep their journal: a new preview
 * there would change nothing, so no button rather than one that fails.
 */
export function canPreview(status: string | undefined): boolean {
  return status === 'draft' || status === 'previewed';
}

/** Changes whenever the worker reports anything new about the job. */
export function progressSignature(job: TagPlanPreviewJob | undefined): string {
  if (!job) return '';
  return [job.jobId, job.state, job.message ?? '', job.done ?? '', job.total ?? ''].join('|');
}

const APPLY_BUSY = new Set(['applying', 'paused']);

/**
 * Whether the plan page polls the plan: while this page's preview request is
 * open, a preview job is queued or running, the page waits for a status it
 * asked for to change, or an apply is running or paused.
 */
export function shouldPollPlan(i: {
  previewRequested: boolean;
  jobActive: boolean;
  awaiting: string | null;
  status: string | undefined;
}): boolean {
  return i.previewRequested || i.jobActive || i.awaiting !== null || (i.status !== undefined && APPLY_BUSY.has(i.status));
}

/**
 * The status the page waits to see change after POST /preview succeeds.
 * A previewed plan goes back to draft on the server, and until the page sees
 * that it must keep polling, or it would go on showing the old diff with
 * Apply enabled. A draft already polls through its preview job.
 */
export function awaitAfterPreview(statusBefore: string | undefined): string | null {
  return statusBefore === 'previewed' ? 'previewed' : null;
}
