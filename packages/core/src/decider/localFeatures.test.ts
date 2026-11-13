import { describe, it, expect } from 'vitest';
import type { CandidateEvidence } from '../matching/evidence.js';
import type { GroupingCandidate, TracklistGroup } from './grouping.js';
import {
  LOCAL_FEATURES_VERSION, LOCAL_FEATURE_NAMES, BREAKDOWN_FEATURE_KEYS,
  candidateFeatures, featuresSchemaHash, groupFeatures, type LocalCandidate,
} from './localFeatures.js';

const ev = {} as CandidateEvidence; // grouping is given; features never read the evidence
const gc = (releaseId: string, distance: number): GroupingCandidate => ({ releaseId, distance, evidence: ev });
const group = (label: string, members: GroupingCandidate[]): TracklistGroup => ({ label, anchor: members[0]!, members, closed: false });
const cand = (releaseId: string, distance: number, extra: Partial<LocalCandidate> = {}): LocalCandidate => ({
  releaseId, distance, breakdown: { album: 0.1, artist: 0.2 }, acoustidCoverage: 0.5, provider: 'musicbrainz', ...extra,
});
const at = (row: number[], name: string): number => row[LOCAL_FEATURE_NAMES.indexOf(name)]!;

// three groups: A = {a1, a2}, B = {b1}, C = {c1, c2, c3}
const cands = [
  cand('a1', 0.10, { breakdown: { album: 0.01, tracks: 0.05, missingTracks: 0.02 }, acoustidCoverage: 0.9 }),
  cand('a2', 0.12, { provider: 'discogs' }),
  cand('b1', 0.25, { provider: 'discogs', acoustidCoverage: null, breakdown: null }),
  cand('c1', 0.40), cand('c2', 0.35), cand('c3', 0.50),
];
const groups = [
  group('A', [gc('a1', 0.10), gc('a2', 0.12)]),
  group('B', [gc('b1', 0.25)]),
  group('C', [gc('c2', 0.35), gc('c1', 0.40), gc('c3', 0.50)]),
];

describe('local decider features', () => {
  it('has a fixed, ordered list of names', () => {
    expect(LOCAL_FEATURES_VERSION).toBe(1);
    expect(LOCAL_FEATURE_NAMES).toEqual([
      'distance', 'gap', 'isBest', 'rank', 'count', 'memberCount',
      'acoustidCoverage', 'acoustidNull', 'discogs',
      'bd_album', 'bd_artist', 'bd_tracks', 'bd_trackTitle', 'bd_year',
      'bd_missingTracks', 'bd_unmatchedTracks', 'bd_mediums', 'bd_albumId',
    ]);
    expect(BREAKDOWN_FEATURE_KEYS.map((k) => `bd_${k}`)).toEqual(LOCAL_FEATURE_NAMES.filter((n) => n.startsWith('bd_')));
    for (const r of groupFeatures(groups, cands)) expect(r.features).toHaveLength(LOCAL_FEATURE_NAMES.length);
  });

  it('takes a group\'s features from its lowest-distance member', () => {
    const rows = groupFeatures(groups, cands);
    expect(rows.map((r) => r.label)).toEqual(['A', 'B', 'C']);
    const a = rows[0]!.features;
    expect(at(a, 'distance')).toBe(0.10);
    expect(at(a, 'acoustidCoverage')).toBe(0.9);
    expect(at(a, 'discogs')).toBe(0); // a1 is MusicBrainz, a2 Discogs
    expect(at(a, 'bd_album')).toBe(0.01);
    expect(at(a, 'memberCount')).toBe(2);
    // c2 (0.35) is the best of C even though c1 is listed second in the input candidates
    const c = rows[2]!.features;
    expect(at(c, 'distance')).toBe(0.35);
    expect(at(c, 'memberCount')).toBe(3);
  });

  it('gap, rank, best and count are measured against the other groups', () => {
    const [a, b, c] = groupFeatures(groups, cands).map((r) => r.features) as [number[], number[], number[]];
    expect(at(a, 'gap')).toBeCloseTo(0.25 - 0.10, 12);
    expect(at(b, 'gap')).toBeCloseTo(0.10 - 0.25, 12);
    expect(at(c, 'gap')).toBeCloseTo(0.10 - 0.35, 12);
    expect([a, b, c].map((r) => at(r, 'rank'))).toEqual([0, 1, 2]);
    expect([a, b, c].map((r) => at(r, 'isBest'))).toEqual([1, 0, 0]);
    expect([a, b, c].map((r) => at(r, 'count'))).toEqual([3, 3, 3]);
  });

  it('a lone group gets the fixed gap for "no rival"', () => {
    const [row] = groupFeatures([group('A', [gc('x', 0.2)])], [cand('x', 0.2)]);
    expect(at(row!.features, 'gap')).toBe(1);
    expect(at(row!.features, 'isBest')).toBe(1);
    expect(at(row!.features, 'count')).toBe(1);
  });

  it('a null AcoustID coverage is -1 with the null flag set', () => {
    const b = groupFeatures(groups, cands)[1]!.features;
    expect(at(b, 'acoustidCoverage')).toBe(-1);
    expect(at(b, 'acoustidNull')).toBe(1);
    expect(at(b, 'discogs')).toBe(1);
    const a = groupFeatures(groups, cands)[0]!.features;
    expect(at(a, 'acoustidNull')).toBe(0);
  });

  it('missing breakdown keys (or no breakdown) are 0, unknown keys are ignored', () => {
    const rows = groupFeatures(groups, cands);
    const a = rows[0]!.features;
    expect(at(a, 'bd_artist')).toBe(0);
    expect(at(a, 'bd_year')).toBe(0);
    expect(at(a, 'bd_tracks')).toBe(0.05);
    for (const k of BREAKDOWN_FEATURE_KEYS) expect(at(rows[1]!.features, `bd_${k}`)).toBe(0);
    const extra = candidateFeatures('x', [cand('x', 0.2, { breakdown: { somethingNew: 7, album: 0.3 } })]);
    expect(extra).toEqual(candidateFeatures('x', [cand('x', 0.2, { breakdown: { album: 0.3 } })]));
  });

  it('non-finite input throws a RangeError', () => {
    const bad: Array<Partial<LocalCandidate>> = [
      { distance: Number.NaN }, { distance: Number.POSITIVE_INFINITY },
      { acoustidCoverage: Number.NaN }, { breakdown: { album: Number.NEGATIVE_INFINITY } },
      { breakdown: { somethingNew: Number.NaN } },
    ];
    for (const b of bad) {
      expect(() => candidateFeatures('x', [cand('x', 0.2, b)])).toThrow(RangeError);
      expect(() => groupFeatures([group('A', [gc('x', 0.2)])], [cand('x', 0.2, b)])).toThrow(RangeError);
    }
  });

  it('rejects a group member with no candidate row and a release listed twice', () => {
    expect(() => groupFeatures([group('A', [gc('nope', 0.2)])], [cand('x', 0.2)])).toThrow(/nope/);
    expect(() => candidateFeatures('nope', [cand('x', 0.2)])).toThrow(/nope/);
    expect(() => candidateFeatures('x', [cand('x', 0.2), cand('x', 0.3)])).toThrow(/twice/);
  });

  it('gives identical output for any input order', () => {
    const want = groupFeatures(groups, cands);
    const rev = <T>(xs: T[]) => [...xs].reverse();
    const orders: Array<[TracklistGroup[], LocalCandidate[]]> = [
      [rev(groups), rev(cands)],
      [[groups[1]!, groups[2]!, groups[0]!].map((g) => ({ ...g, members: rev(g.members) })), [cands[3]!, cands[0]!, cands[5]!, cands[1]!, cands[4]!, cands[2]!]],
      [[groups[2]!, groups[0]!, groups[1]!], [cands[2]!, cands[4]!, cands[1]!, cands[5]!, cands[0]!, cands[3]!]],
    ];
    for (const [g, c] of orders) expect(groupFeatures(g, c)).toEqual(want);
    const one = candidateFeatures('c1', cands);
    for (const [, c] of orders) expect(candidateFeatures('c1', c)).toEqual(one);
  });

  it('orders rows by label order, AA after Z', () => {
    const many = Array.from({ length: 28 }, (_, i) => cand(`r${String(i).padStart(2, '0')}`, 0.01 * (i + 1)));
    const labelOf = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`);
    const gs = many.map((c, i) => group(labelOf(i), [gc(c.releaseId, c.distance)]));
    expect(groupFeatures([...gs].reverse(), many).map((r) => r.label).slice(24)).toEqual(['Y', 'Z', 'AA', 'AB']);
  });

  it('a one-member group equals candidateFeatures when every candidate is its own group', () => {
    const solo = cands.map((c) => group('?', [gc(c.releaseId, c.distance)]));
    const ordered = [...solo].sort((x, y) => x.members[0]!.distance - y.members[0]!.distance);
    const labelled = ordered.map((g, i) => ({ ...g, label: String.fromCharCode(65 + i) }));
    for (const row of groupFeatures(labelled, cands)) {
      const g = labelled.find((x) => x.label === row.label)!;
      expect(row.features).toEqual(candidateFeatures(g.members[0]!.releaseId, cands));
    }
  });

  it('candidateFeatures ranks a candidate among its album\'s candidates', () => {
    const f = candidateFeatures('a2', cands);
    expect(at(f, 'rank')).toBe(1);
    expect(at(f, 'isBest')).toBe(0);
    expect(at(f, 'count')).toBe(6);
    expect(at(f, 'memberCount')).toBe(1);
    expect(at(f, 'gap')).toBeCloseTo(0.10 - 0.12, 12);
    expect(at(f, 'discogs')).toBe(1);
    // equal distances: the release id breaks the tie, the gap is 0
    const tie = [cand('p', 0.2), cand('q', 0.2)];
    expect([at(candidateFeatures('p', tie), 'rank'), at(candidateFeatures('q', tie), 'rank')]).toEqual([0, 1]);
    expect(at(candidateFeatures('p', tie), 'gap')).toBe(0);
  });

  it('pins the schema hash', () => {
    expect(featuresSchemaHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(featuresSchemaHash()).toBe('ba31d323beaaa278dc53da1ed63e02245404f0358a34f937ae1f0f468bc58721');
  });
});
