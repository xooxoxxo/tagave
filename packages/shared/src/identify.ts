/**
 * Owner-requested identification: what the album page shows about the one
 * request for an album, derived from the live pg-boss job and the outcome the
 * worker recorded when it ended (identify_runs). Never a stale flag.
 */

export type IdentifyRequestKind = 'mbid' | 'release_group' | 'discogs' | 'reidentify' | 'sweep';

/**
 * identify.album / identify.acoustid job data carries `requestedBy: 'owner'`
 * when the owner asked for this album (match input, Re-identify, triage
 * retry). Only those runs record an outcome and show as a request; the
 * system's own force:true runs (fingerprint lookups, disc repair) do not.
 */
export const IDENTIFY_REQUESTED_BY_OWNER = 'owner' as const;

/** How a finished request ended. */
export type IdentifyOutcomeKind =
  | 'matched'
  | 'needs_review'
  | 'unidentified'
  /** the id is a MusicBrainz release group: the owner picks one of its releases */
  | 'release_group'
  /** the id does not exist on the provider */
  | 'not_found'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  /** finished before outcomes were recorded; only the album state tells */
  | 'unknown';

/** One release of a release group, ranked by how well it fits the local files. */
export interface ReleaseChoice {
  mbid: string;
  title: string;
  disambiguation?: string;
  date?: string;
  country?: string;
  status?: string;
  /** "CD", "2×CD", "Digital Media", "CD + DVD" */
  formats?: string;
  trackCount: number | null;
  mediumCount: number;
  label?: string;
  catalogNumber?: string;
  /** release tracks minus local tracks; null when the release names no count */
  trackDelta: number | null;
  /** exact: same track count (and disc count when known); close: within 2 tracks */
  fit: 'exact' | 'close' | 'far';
}

export interface IdentifyOutcomeView {
  kind: IdentifyOutcomeKind;
  /** plain sentence for the owner */
  message: string;
  finishedAt: string;
  releaseGroup?: { mbid: string; title: string };
  choices?: ReleaseChoice[];
  /** releases in the group beyond the listed choices */
  moreChoices?: number;
}

export interface IdentifyRequestView {
  /** queued/running/retrying: a live pg-boss job; done: it ended (see outcome) */
  status: 'queued' | 'running' | 'retrying' | 'done';
  jobId: string | null;
  kind: IdentifyRequestKind;
  /** the id the owner pasted, as the job carries it */
  pinned: string | null;
  createdAt: string | null;
  startedAt: string | null;
  /** jobs ahead of this one in the queue (queued only) */
  jobsAhead: number;
  outcome: IdentifyOutcomeView | null;
}
