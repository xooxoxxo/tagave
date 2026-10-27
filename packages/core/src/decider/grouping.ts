/**
 * Tracklist grouping: the shapes and the tolerances.
 *
 * Candidates are grouped by tracklist identity (per-medium or total track
 * counts, the title sequence, and durations where both sides have them; a
 * missing duration is a wildcard), never by release group. Each group is
 * anchored on its best-distance member and grows only by members that fit
 * the anchor, with no chaining through other members.
 *
 * Two tracklists fit when their track counts match (per medium when the
 * local album knows its discs, else in total), their titles agree (mean
 * per-track text distance at most 0.15, no track over 0.5) and every pair of
 * known durations is within 10 s. Anchors come from candidates whose
 * durations are all known, best distance first; candidates with a missing
 * duration join after them. A member joins only when exactly one open group
 * fits; when two do it stays alone in a closed group of its own.
 *
 * Only remote tracklists are compared with each other. Nothing here reads
 * the local files' titles, so names taken from file names or folders never
 * reach a group's key or label.
 *
 * The tolerances are part of the hashed question spec, so a decision names
 * the grouping it was made under. They are frozen: changing one is a new
 * spec version, not a run-time setting.
 */
import { stringDistance } from '../text/index.js';
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

/** Track counts per medium in medium order (no medium counts as medium 1), or the total. */
export function countsKey(ev: CandidateEvidence, byMedium: boolean): number[] {
  if (!byMedium) return [ev.tracks.length];
  const counts = new Map<number, number>();
  for (const [m] of ev.tracks) counts.set(m ?? 1, (counts.get(m ?? 1) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
}

/** True when any track has no known duration. */
export function hasWildcards(ev: CandidateEvidence): boolean {
  return ev.tracks.some((t) => t[2] === null);
}

const sameNumbers = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Whether `member` has the same tracklist as `anchor` under the tolerances. */
export function fits(anchor: CandidateEvidence, member: CandidateEvidence, byMedium: boolean, opts: GroupingOptions = GROUPING_DEFAULTS): boolean {
  if (anchor.tracks.length !== member.tracks.length) return false;
  if (!sameNumbers(countsKey(anchor, byMedium), countsKey(member, byMedium))) return false;
  if (anchor.tracks.length === 0) return true;
  let sum = 0;
  for (let i = 0; i < anchor.tracks.length; i++) {
    const [, ta, da] = anchor.tracks[i]!;
    const [, tm, dm] = member.tracks[i]!;
    const d = stringDistance(ta, tm);
    if (d > opts.maxTitleDistance) return false;
    sum += d;
    if (da !== null && dm !== null && Math.abs(da - dm) > opts.durationToleranceS) return false;
  }
  return sum / anchor.tracks.length <= opts.meanTitleTolerance;
}

/** 0 → 'A', 25 → 'Z', 26 → 'AA': distinct for every index. */
export function groupLabel(index: number): string {
  let n = index;
  let s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

const byDistance = (a: GroupingCandidate, b: GroupingCandidate) =>
  a.distance - b.distance || (a.releaseId < b.releaseId ? -1 : a.releaseId > b.releaseId ? 1 : 0);

/**
 * Groups candidates by tracklist. Groups come back ordered by their best
 * member's distance (ties: release id) and labelled A, B, C, ...
 */
export function groupTracklists(cands: GroupingCandidate[], local: { discsKnown: boolean }, opts: GroupingOptions = GROUPING_DEFAULTS): TracklistGroup[] {
  const ordered = [...cands].sort(byDistance);
  const groups: Array<{ anchor: GroupingCandidate; members: GroupingCandidate[]; closed: boolean }> = [];
  const place = (c: GroupingCandidate) => {
    const open = groups.filter((g) => !g.closed && fits(g.anchor.evidence, c.evidence, local.discsKnown, opts));
    if (open.length === 1) open[0]!.members.push(c);
    else groups.push({ anchor: c, members: [c], closed: open.length > 1 });
  };
  for (const c of ordered.filter((x) => !hasWildcards(x.evidence))) place(c);
  for (const c of ordered.filter((x) => hasWildcards(x.evidence))) place(c);
  const best = (g: { members: GroupingCandidate[] }) => [...g.members].sort(byDistance)[0]!;
  return groups
    .sort((a, b) => byDistance(best(a), best(b)))
    .map((g, i) => ({ label: groupLabel(i), anchor: g.anchor, members: [g.anchor, ...g.members.filter((m) => m !== g.anchor).sort(byDistance)], closed: g.closed }));
}
