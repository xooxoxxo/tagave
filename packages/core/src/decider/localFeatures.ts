/**
 * Feature rows for the local decider: plain numbers from what the matcher
 * already stored (its distance and breakdown, AcoustID coverage, provider)
 * and from where a candidate stands among the album's others. Pure; nothing
 * here reads files or the network.
 *
 * The local decider scores the same tracklist groups the other deciders
 * answer (the groups requestForAlbum makes), so its probabilities go through
 * decideFromProbabilities and pickEdition unchanged. A group's row is the
 * row of its best member (lowest distance, ties by release id), with the
 * standing features (gap, rank, best, count) measured against the other
 * groups' best members and memberCount set to the group's size.
 *
 * Training also scores single candidates (candidateFeatures). The rule that
 * keeps the two consistent: a candidate is treated as a group of one, and
 * its standing is measured against every other candidate of the album. So a
 * one-member group in an album where every candidate is its own group has
 * exactly the row candidateFeatures gives that candidate.
 *
 * The names and their order are the model's schema: adding, removing or
 * reordering one is a new LOCAL_FEATURES_VERSION, and featuresSchemaHash
 * changes with it, so a stored model is never applied to rows it was not
 * trained on.
 */
import { createHash } from 'node:crypto';
import { stableJson } from '../matching/evidence.js';
import type { TracklistGroup } from './grouping.js';

export const LOCAL_FEATURES_VERSION = 1;

/** Matcher breakdown keys read into features, in feature order; a missing key is 0. */
export const BREAKDOWN_FEATURE_KEYS: readonly string[] = Object.freeze([
  'album', 'artist', 'tracks', 'trackTitle', 'year', 'missingTracks', 'unmatchedTracks', 'mediums', 'albumId',
]);

/**
 * - distance: the best member's matcher distance
 * - gap: best distance of the others minus this one (positive when this one leads); NO_RIVAL_GAP when alone
 * - isBest: 1 for rank 0
 * - rank: 0-based place by distance (ties by release id)
 * - count: how many groups (candidates, for candidateFeatures) the album has
 * - memberCount: the group's size (1 for a single candidate)
 * - acoustidCoverage: the best member's coverage, -1 when unknown; acoustidNull: 1 when unknown
 * - discogs: 1 when the best member comes from Discogs
 * - bd_<key>: the best member's breakdown value for that key, 0 when missing
 */
export const LOCAL_FEATURE_NAMES: readonly string[] = Object.freeze([
  'distance', 'gap', 'isBest', 'rank', 'count', 'memberCount',
  'acoustidCoverage', 'acoustidNull', 'discogs',
  ...BREAKDOWN_FEATURE_KEYS.map((k) => `bd_${k}`),
]);

/** The gap of a group (or candidate) with no rival: the widest a distance gap can be. */
export const NO_RIVAL_GAP = 1;

export interface LocalCandidate {
  releaseId: string;
  distance: number;
  breakdown: Record<string, number> | null;
  acoustidCoverage: number | null;
  provider: 'musicbrainz' | 'discogs';
}

export interface FeatureRow { label: string; features: number[] }

function finite(x: number, what: string, id: string): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new RangeError(`local features: ${what} of ${id} is not a finite number (${x})`);
  return x;
}

/** Checks every number of a candidate, including breakdown keys not read into features. */
function checked(c: LocalCandidate): LocalCandidate {
  finite(c.distance, 'distance', c.releaseId);
  if (c.acoustidCoverage !== null && c.acoustidCoverage !== undefined) finite(c.acoustidCoverage, 'AcoustID coverage', c.releaseId);
  if (c.breakdown) for (const [k, v] of Object.entries(c.breakdown)) finite(v, `breakdown ${k}`, c.releaseId);
  return c;
}

/** Candidates by release id; each release once (two rows for one release would make the row ambiguous). */
function index(candidates: LocalCandidate[]): Map<string, LocalCandidate> {
  const byId = new Map<string, LocalCandidate>();
  for (const c of candidates) {
    if (byId.has(c.releaseId)) throw new Error(`local features: release ${c.releaseId} is listed twice`);
    byId.set(c.releaseId, checked(c));
  }
  return byId;
}

const byDistance = (a: LocalCandidate, b: LocalCandidate): number =>
  a.distance - b.distance || (a.releaseId < b.releaseId ? -1 : a.releaseId > b.releaseId ? 1 : 0);

/** A, B, ..., Z, AA, AB: shorter labels first, then alphabetical. */
const byLabel = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/** One row: `best` is the unit's best member, `units` every unit's best member in rank order. */
function row(best: LocalCandidate, units: LocalCandidate[], memberCount: number): number[] {
  const rank = units.indexOf(best);
  const rival = units.find((u) => u !== best);
  const out = [
    best.distance,
    rival === undefined ? NO_RIVAL_GAP : rival.distance - best.distance,
    rank === 0 ? 1 : 0,
    rank,
    units.length,
    memberCount,
    best.acoustidCoverage ?? -1,
    best.acoustidCoverage === null || best.acoustidCoverage === undefined ? 1 : 0,
    best.provider === 'discogs' ? 1 : 0,
    ...BREAKDOWN_FEATURE_KEYS.map((k) => best.breakdown?.[k] ?? 0),
  ];
  for (const x of out) if (!Number.isFinite(x)) throw new RangeError(`local features: a feature of ${best.releaseId} is not finite (${x})`);
  return out;
}

/**
 * One row per tracklist group, in label order. Every member of every group
 * must have a candidate row; the rows' values, not the group's copies, are
 * read.
 */
export function groupFeatures(groups: TracklistGroup[], candidates: LocalCandidate[]): FeatureRow[] {
  const byId = index(candidates);
  const seen = new Set<string>();
  const bests = groups.map((g) => {
    if (seen.has(g.label)) throw new Error(`local features: group label ${g.label} is used twice`);
    seen.add(g.label);
    if (g.members.length === 0) throw new Error(`local features: group ${g.label} has no members`);
    const members = g.members.map((m) => {
      const c = byId.get(m.releaseId);
      if (!c) throw new Error(`local features: no candidate row for release ${m.releaseId} of group ${g.label}`);
      return c;
    });
    return { label: g.label, best: [...members].sort(byDistance)[0]!, size: members.length };
  });
  const units = bests.map((b) => b.best).sort(byDistance);
  return bests
    .sort((a, b) => byLabel(a.label, b.label))
    .map((b) => ({ label: b.label, features: row(b.best, units, b.size) }));
}

/** The row of one candidate, as a group of one among its album's candidates (each its own group). */
export function candidateFeatures(releaseId: string, candidates: LocalCandidate[]): number[] {
  const byId = index(candidates);
  const c = byId.get(releaseId);
  if (!c) throw new Error(`local features: no candidate row for release ${releaseId}`);
  return row(c, [...byId.values()].sort(byDistance), 1);
}

/** The schema a model is trained on: the version and the names, in order. */
export function featuresSchemaHash(): string {
  return createHash('sha256').update(stableJson({ v: LOCAL_FEATURES_VERSION, names: LOCAL_FEATURE_NAMES, noRivalGap: NO_RIVAL_GAP })).digest('hex');
}
