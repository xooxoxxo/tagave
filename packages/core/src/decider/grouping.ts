/**
 * Tracklist grouping: the shapes and the tolerances.
 *
 * Candidates are grouped by tracklist identity (per-medium or total track
 * counts, the title sequence, and durations where both sides have them; a
 * missing duration is a wildcard), never by release group. Each group is
 * anchored on its best-distance member and grows only by members that fit
 * the anchor, with no chaining through other members.
 *
 * The tolerances are part of the hashed question spec, so a decision names
 * the grouping it was made under. They are frozen: changing one is a new
 * spec version, not a run-time setting.
 */
import type { CandidateEvidence } from '../matching/evidence.js';

export interface GroupingCandidate { releaseId: string; distance: number; evidence: CandidateEvidence }
export interface TracklistGroup {
  label: string;
  anchor: GroupingCandidate;
  /** anchor first, then by distance */
  members: GroupingCandidate[];
  /** a wildcard member that fit more than one group sits alone in a closed group; nothing joins it */
  closed: boolean;
}
export interface GroupingOptions {
  /** mean per-track title distance at most this */
  meanTitleTolerance: number;
  /** no single track's title distance over this */
  maxTitleDistance: number;
  /** every pair of known durations within this many seconds */
  durationToleranceS: number;
}

export const GROUPING_DEFAULTS: Readonly<GroupingOptions> = Object.freeze({
  meanTitleTolerance: 0.15,
  maxTitleDistance: 0.5,
  durationToleranceS: 10,
});
