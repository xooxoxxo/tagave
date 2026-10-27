/**
 * One album's Jev request, from its stored evidence. The one place a request
 * is made: decider.run sends what this returns, and the payload preview the
 * owner must see before the first run shows what this returns, so what the
 * owner approved is byte for byte what goes out for the same album and
 * model.
 *
 * The candidates are the album's sendable ones (never excluded, never a
 * linked app's suggestion), each release once at its best distance, in
 * distance order. They are grouped by tracklist and the first groups and
 * the first editions of each are shown. An album that may not be sent
 * throws NotSendableError with the reason; anything else it throws is about
 * the stored evidence not holding together.
 */
import type { AlbumEvidence, CandidateEvidence, EvidenceCandidate } from '../matching/evidence.js';
import { evidenceHash } from '../matching/evidence.js';
import { groupTracklists, type GroupingCandidate, type TracklistGroup } from './grouping.js';
import { buildJevRequest, NotSendableError, requestBytes, type JevRequest } from './jevPayload.js';
import { JEV_SPEC } from './jevSpec.js';

/**
 * At most this many tracklist groups go into one request: the best eight by
 * distance (labels A to H). Each group adds its whole tracklist to the
 * shared state, so the request grows with groups × tracks; groups past the
 * eighth are the scorer's far-off candidates, and leaving one out can only
 * turn a pick into "none" (the decider answers each group on its own).
 */
export const MAX_GROUPS = 8;
/**
 * At most this many editions of one group are shown. Editions of a group
 * share its tracklist, so they only add label, country and catalogue lines;
 * the edition accepted is still chosen by the owner's rules from every
 * member of the group, shown or not.
 */
export const MAX_EDITIONS_PER_GROUP = 5;
/** Candidates sent per album from the weak population: the best five by distance. */
export const WEAK_TOP_CANDIDATES = 5;

export interface AlbumRequest {
  request: JevRequest;
  /** UTF-8 bytes of the request's JSON, the size the service sees */
  bytes: number;
  /** every tracklist group of the candidates (the decision's group and its editions come from here) */
  groups: TracklistGroup[];
  /** the groups shown, with the editions shown */
  sent: TracklistGroup[];
  /** the labels of the groups shown, the only answers the decision reads */
  labels: string[];
  /** the candidates grouped: each release once, in distance order (the best five for a weak album) */
  candidates: Array<EvidenceCandidate & { evidence: CandidateEvidence }>;
}

export interface RequestOptions {
  model: string;
  /** an album of the weak population: only its best few candidates go */
  weak?: boolean;
  /** a sendable candidate of the album has no evidence yet (the loader leaves such candidates out) */
  partial?: boolean;
  /** the library's limit on a request's size; null or missing: none */
  maxRequestBytes?: number | null;
}

const byDistance = <T extends { releaseId: string; distance: number }>(a: T, b: T): number =>
  a.distance - b.distance || (a.releaseId < b.releaseId ? -1 : a.releaseId > b.releaseId ? 1 : 0);

export function requestForAlbum<C extends EvidenceCandidate>(album: AlbumEvidence, candidates: C[], opts: RequestOptions): AlbumRequest & { candidates: Array<C & { evidence: CandidateEvidence }> } {
  // the decider would judge part of the set
  if (opts.partial || candidates.some((c) => c.evidence === null || c.evidence === undefined)) throw new NotSendableError('partial_evidence');
  const seen = new Set<string>();
  let cands = [...candidates].sort(byDistance).filter((c) => (seen.has(c.releaseId) ? false : (seen.add(c.releaseId), true))) as Array<C & { evidence: CandidateEvidence }>;
  if (opts.weak) cands = cands.slice(0, WEAK_TOP_CANDIDATES);
  if (cands.length === 0) throw new NotSendableError('no_candidates');
  const groups = groupTracklists(
    cands.map((c): GroupingCandidate => ({ releaseId: c.releaseId, distance: c.distance, evidence: c.evidence })),
    { discsKnown: album.discsKnown }, JEV_SPEC.grouping);
  const sent = groups.slice(0, MAX_GROUPS).map((g) => ({ ...g, members: g.members.slice(0, MAX_EDITIONS_PER_GROUP) }));
  const request = buildJevRequest(album, sent, opts.model);
  const bytes = requestBytes(request);
  if (opts.maxRequestBytes !== null && opts.maxRequestBytes !== undefined && bytes > opts.maxRequestBytes) throw new NotSendableError('too_large', bytes);
  return { request, bytes, groups, sent, labels: sent.map((g) => g.label), candidates: cands };
}

/** The hash a decision is pinned to: the album's evidence and its sendable candidates. */
export function hashOf(ev: { album: AlbumEvidence; candidates: EvidenceCandidate[] }): string {
  return evidenceHash(ev.album, ev.candidates);
}
