/**
 * Gap decisions and the Tasks list (0032).
 *
 * Every gap offers three choices:
 * - "Add to my tasks" → state `todo`: the owner confirmed it and will fix it;
 *   the next gap check after a scan marks it `resolved` once the condition is
 *   gone, and `acceptedAt` keeps it on the list as done.
 * - "Not a problem" → `dismissed` with reason `not_interested`.
 * - "This is wrong" → `dismissed` with reason `wrong_data` (the check made a mistake).
 */
export type GapState = 'open' | 'todo' | 'dismissed' | 'resolved';
export type GapDismissReason = 'not_interested' | 'wrong_data' | 'own_elsewhere';

/** Done tasks stay listed this many days after the scan resolved them. */
export const TASK_DONE_DAYS = 30;

/** Longest note the owner can keep on a task. */
export const TASK_NOTE_MAX = 500;

export interface GapTask {
  id: string;
  kind: string;
  /** quality gaps: the one flag (noCover, lowBitrate, …); '' otherwise */
  flag: string;
  state: 'todo' | 'resolved';
  subjectType: string;
  subjectId: string;
  details: Record<string, unknown>;
  note: string | null;
  acceptedAt: string;
  resolvedAt: string | null;
  /** the album page to open: the subject album, or the first copy of a duplicate */
  albumId: string | null;
  /** album or release group title */
  title: string | null;
  artist: string | null;
  artistId: string | null;
  /** the album's first folder, relative to its scan root */
  folder: string | null;
  /** the album or release group no longer exists (removed from the library) */
  subjectGone: boolean;
}

export interface GapTasksResponse {
  todo: GapTask[];
  done: GapTask[];
}

export interface GapTaskCounts {
  todo: number;
  /** resolved within TASK_DONE_DAYS */
  done: number;
}
