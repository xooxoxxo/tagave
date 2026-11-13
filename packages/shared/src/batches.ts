/**
 * Accept batches as the api lists them (Library care › Review › batches):
 * what a set of albums accepted at once did, who ran it, what an undo
 * cannot take back, and how long the downstream bridging needs.
 */

/** Releases waiting on the nightly bridge, and the nights the pace needs. */
export interface DrainEstimate { pending: number; perNight: number; nights: number; limit: number }

export interface BatchSummary {
  id: string;
  deciderId: string;
  deciderLabel: string;
  decidedKind: 'rule' | 'model';
  band: string | null;
  state: string;
  createdAt: string;
  startedBy: string | null;
  counts: { accepted: number; skipped: number; undone: number; left: number; pending: number };
  /** what the pending count means: 'Waiting' while the accept runs, 'Not reached' once it stopped */
  pendingLabel: string;
  /** a failed batch: which run stopped ('accept' or 'undo'), from its message */
  failedDuring: 'accept' | 'undo' | null;
  message: string | null;
  drain: DrainEstimate | null;
}

export interface BatchItemView { albumId: string; title: string | null; artist: string | null; reason: string }

export interface BatchDetail extends BatchSummary {
  skipped: BatchItemView[];
  left: BatchItemView[];
  cannotUndo: readonly string[];
}

const capitalise = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** 'jev','jev-2026-09-15' → 'Jev 2026-09'; 'rules' → 'Your rules'; no dated version → the id alone. */
export function deciderLabel(deciderId: string, version: string | null): string {
  if (deciderId === 'rules') return 'Your rules';
  const month = version?.match(/(\d{4}-\d{2})/)?.[1];
  return month ? `${capitalise(deciderId)} ${month}` : capitalise(deciderId);
}

/** Why an album was skipped by the accept or left by the undo. */
export const SKIP_LABELS: Record<string, string> = {
  gone: 'Album gone',
  state: 'Decided meanwhile',
  reidentified: 'Identified again',
  release_gone: 'Edition gone',
  evidence_changed: 'Candidates changed',
  newer_decision: 'Newer decision',
  locks: 'Field locked',
  tag_plan: 'Tag plan',
  state_changed: 'Changed since',
};

/** A batch's failure, by the prefix its run gave the message. */
export function batchFailedDuring(state: string, message: string | null): 'accept' | 'undo' | null {
  if (state !== 'failed') return null;
  return message?.startsWith('Undo stopped:') ? 'undo' : 'accept';
}

/** Pending items are waiting while the accept runs; once it stopped (undone, undoing, failed) they were not reached. */
export function pendingLabel(state: string): string {
  return state === 'queued' || state === 'accepting' ? 'Waiting' : 'Not reached';
}
