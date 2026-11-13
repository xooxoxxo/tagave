import { describe, it, expect } from 'vitest';
import type { CandidateEvidence, RemoteTrack } from '../matching/evidence.js';
import { countsKey, fits, groupLabel, groupTracklists, hasWildcards, type GroupingCandidate } from './grouping.js';

const titles = ['Morgenrot', 'Unter Eis', 'Nachtfahrt', 'Lichtung', 'Kalter Grund', 'Ausklang'];
function ev(tracks: RemoteTrack[], provider: 'musicbrainz' | 'discogs' = 'musicbrainz'): CandidateEvidence {
  return { v: 1, remote: { provider, title: 'Lichtung', artists: ['Ensemble Nord'], year: 2011, country: null, label: null, catalogNumber: null, barcode: null, media: null, mediumCount: null, status: 'Official' },
    tracks, align: tracks.map((_, i) => [i, i, 0]), unmatchedLocal: [], missingRemote: [], capped: false };
}
const list = (opts: { n?: number; medium?: (i: number) => number | null; dur?: (i: number) => number | null; title?: (i: number) => string } = {}): RemoteTrack[] =>
  Array.from({ length: opts.n ?? 6 }, (_, i) => [opts.medium ? opts.medium(i) : 1, opts.title ? opts.title(i) : titles[i % titles.length]!, opts.dur ? opts.dur(i) : 200 + i * 10]);
const c = (id: string, distance: number, tracks: RemoteTrack[], provider?: 'musicbrainz' | 'discogs'): GroupingCandidate => ({ releaseId: id, distance, evidence: ev(tracks, provider) });
const flat = { discsKnown: false };
const discs = { discsKnown: true };
const labels = (gs: ReturnType<typeof groupTracklists>) => gs.map((g) => `${g.label}:${g.members.map((m) => m.releaseId).join(',')}${g.closed ? '!' : ''}`);

describe('groupTracklists', () => {
  it('editions of one tracklist (other country, label, media) are one group', () => {
    expect(labels(groupTracklists([c('uk', 0.05, list()), c('de', 0.06, list()), c('jp', 0.07, list({ dur: (i) => 203 + i * 10 }))], flat))).toEqual(['A:uk,de,jp']);
  });

  it('the MusicBrainz and Discogs copies of one edition are one group (Discogs has no durations: a wildcard)', () => {
    const gs = groupTracklists([c('mb', 0.04, list()), c('dg', 0.03, list({ dur: () => null }), 'discogs')], flat);
    expect(labels(gs)).toEqual(['A:mb,dg']);
    expect(gs[0]!.anchor.releaseId).toBe('mb'); // anchors come from candidates whose durations are all known
  });

  it('a spelling difference on one track still fits; "(Live)" on every track does not', () => {
    const typo = list({ title: (i) => (i === 0 ? 'Morgenrott' : titles[i]!) });
    const live = list({ title: (i) => `${titles[i]!} (Live)` });
    expect(labels(groupTracklists([c('a', 0.05, list()), c('b', 0.06, typo), c('c', 0.07, live)], flat))).toEqual(['A:a,b', 'B:c']);
  });

  it('one wholly different title splits the groups', () => {
    const other = list({ title: (i) => (i === 3 ? 'Ganz anders' : titles[i]!) });
    expect(labels(groupTracklists([c('a', 0.05, list()), c('b', 0.06, other)], flat))).toEqual(['A:a', 'B:b']);
  });

  it('a bonus-track edition stays apart', () => {
    const bonus = [...list(), [1, 'Morgenrot (Demo)', 240] as RemoteTrack];
    expect(labels(groupTracklists([c('std', 0.05, list()), c('bonus', 0.08, bonus)], flat))).toEqual(['A:std', 'B:bonus']);
  });

  it('2xLP and 1-CD stay apart when the local album knows its discs', () => {
    const lp = list({ medium: (i) => (i < 3 ? 1 : 2) });
    expect(labels(groupTracklists([c('cd', 0.05, list()), c('lp', 0.06, lp)], discs))).toEqual(['A:cd', 'B:lp']);
  });

  it('2xLP and 1-CD are one tracklist when the local album says nothing about discs (total count)', () => {
    const lp = list({ medium: (i) => (i < 3 ? 1 : 2) });
    expect(labels(groupTracklists([c('cd', 0.05, list()), c('lp', 0.06, lp)], flat))).toEqual(['A:cd,lp']);
  });

  it('durations more than 10 s apart split; 10 s exactly fits', () => {
    expect(labels(groupTracklists([c('a', 0.05, list()), c('b', 0.06, list({ dur: (i) => 210 + i * 10 }))], flat))).toEqual(['A:a,b']);
    expect(labels(groupTracklists([c('a', 0.05, list()), c('b', 0.06, list({ dur: (i) => 211 + i * 10 }))], flat))).toEqual(['A:a', 'B:b']);
  });

  it('no transitive chaining: a member that fits a member but not the anchor opens its own group', () => {
    // a: 200, b: 208 (fits a), c: 216 (fits b, not a)
    const at = (base: number) => list({ dur: (i) => base + i * 10 });
    expect(labels(groupTracklists([c('a', 0.01, at(200)), c('b', 0.02, at(208)), c('c', 0.03, at(216))], flat))).toEqual(['A:a,b', 'B:c']);
  });

  it('a wildcard member that fits two groups stays alone, closed', () => {
    const at = (base: number) => list({ dur: (i) => base + i * 10 });
    const gs = groupTracklists([c('a', 0.01, at(200)), c('b', 0.02, at(230)), c('dg', 0.03, list({ dur: () => null }), 'discogs')], flat);
    expect(labels(gs)).toEqual(['A:a', 'B:b', 'C:dg!']);
  });

  it('a fully timed candidate that fits two timed anchors stays alone, closed', () => {
    // a: 200, b: 211 (11 s from a, its own group), mid: 205 (fits both)
    const at = (base: number) => list({ dur: (i) => base + i * 10 });
    const gs = groupTracklists([c('a', 0.01, at(200)), c('b', 0.02, at(211)), c('mid', 0.03, at(205))], flat);
    expect(labels(gs)).toEqual(['A:a', 'B:b', 'C:mid!']);
  });

  it('under an anchor with no durations, members whose durations conflict with each other share the group', () => {
    // The wildcard anchor says nothing about durations, and each member is
    // compared with the anchor only, so 200 s and 230 s both join it.
    const partly = (base: number) => list({ dur: (i) => (i % 2 ? null : base + i * 10) });
    const p200 = c('p200', 0.02, partly(200));
    const p230 = c('p230', 0.03, partly(230));
    expect(fits(p200.evidence, p230.evidence, false)).toBe(false);
    const gs = groupTracklists([c('none', 0.01, list({ dur: () => null })), p200, p230], flat);
    expect(labels(gs)).toEqual(['A:none,p200,p230']);
    expect(gs[0]!.anchor.releaseId).toBe('none');
  });

  it('a later member never joins a closed group', () => {
    const at = (base: number) => list({ dur: (i) => base + i * 10 });
    const gs = groupTracklists([c('a', 0.01, at(200)), c('b', 0.02, at(230)), c('dg1', 0.03, list({ dur: () => null })), c('dg2', 0.04, list({ dur: () => null }))], flat);
    expect(labels(gs)).toEqual(['A:a', 'B:b', 'C:dg1!', 'D:dg2!']);
  });

  it('wildcard-only candidates group with each other', () => {
    expect(labels(groupTracklists([c('dg1', 0.03, list({ dur: () => null })), c('dg2', 0.04, list({ dur: () => null }))], flat))).toEqual(['A:dg1,dg2']);
  });

  it('a partly known duration list is a wildcard member', () => {
    const half = list({ dur: (i) => (i % 2 ? null : 200 + i * 10) });
    expect(hasWildcards(ev(half))).toBe(true);
    expect(labels(groupTracklists([c('a', 0.05, list()), c('half', 0.04, half)], flat))).toEqual(['A:a,half']);
  });

  it('groups are ordered by their best member and labelled A, B, …', () => {
    const other = list({ title: () => 'Anders' });
    expect(labels(groupTracklists([c('far', 0.2, other), c('near', 0.01, list()), c('wild', 0.0, list({ dur: () => null }))], flat))).toEqual(['A:near,wild', 'B:far']);
  });

  it('is deterministic for equal distances (release id breaks the tie)', () => {
    const a = groupTracklists([c('y', 0.05, list()), c('x', 0.05, list())], flat);
    expect(a[0]!.anchor.releaseId).toBe('x');
  });

  it('no candidates, no groups', () => expect(groupTracklists([], flat)).toEqual([]));

  it('an empty remote tracklist only fits another empty one', () => {
    expect(labels(groupTracklists([c('a', 0.1, []), c('b', 0.2, list())], flat))).toEqual(['A:a', 'B:b']);
  });
});

describe('helpers', () => {
  it('countsKey per medium or total', () => {
    const t = list({ medium: (i) => (i < 4 ? 1 : 2) });
    expect(countsKey(ev(t), true)).toEqual([4, 2]);
    expect(countsKey(ev(t), false)).toEqual([6]);
    expect(countsKey(ev(list({ medium: () => null })), true)).toEqual([6]); // no medium is medium 1
  });
  it('fits is symmetric for full lists', () => {
    const a = ev(list()); const b = ev(list({ dur: (i) => 205 + i * 10 }));
    expect(fits(a, b, false)).toBe(fits(b, a, false));
  });
  it('labels past Z', () => {
    expect([0, 25, 26, 27].map(groupLabel)).toEqual(['A', 'Z', 'AA', 'AB']);
  });
});

describe('determinism and labels', () => {
  const at = (base: number) => list({ dur: (i) => base + i * 10 });
  const pool = (): GroupingCandidate[] => [
    c('a', 0.01, at(200)),
    c('b', 0.02, at(208)),
    c('c', 0.03, at(216)),
    c('d', 0.03, at(230)),
    c('dg1', 0.0, list({ dur: () => null }), 'discogs'),
    c('dg2', 0.05, list({ dur: () => null }), 'discogs'),
    c('live', 0.04, list({ title: (i) => `${titles[i]!} (Live)` })),
    c('bonus', 0.02, [...list(), [1, 'Morgenrot (Demo)', 240] as RemoteTrack]),
    c('tie', 0.02, at(208)),
  ];
  const shape = (gs: ReturnType<typeof groupTracklists>) => gs.map((g) => ({ label: g.label, anchor: g.anchor.releaseId, members: g.members.map((m) => m.releaseId), closed: g.closed }));

  it('the same candidates in any input order give the same groups, labels and anchors', () => {
    const forward = pool();
    const reversed = [...pool()].reverse();
    const shuffled = [4, 0, 8, 2, 6, 1, 7, 3, 5].map((i) => pool()[i]!);
    const interleaved = [1, 3, 5, 7, 0, 2, 4, 6, 8].map((i) => pool()[i]!);
    const expected = shape(groupTracklists(forward, flat));
    expect(expected.length).toBeGreaterThan(1);
    for (const order of [reversed, shuffled, interleaved]) {
      expect(shape(groupTracklists(order, flat))).toEqual(expected);
      expect(shape(groupTracklists(order, discs))).toEqual(shape(groupTracklists(forward, discs)));
    }
  });

  it('does not reorder or change the input', () => {
    const input = pool();
    const before = input.map((x) => x.releaseId);
    groupTracklists(input, flat);
    expect(input.map((x) => x.releaseId)).toEqual(before);
  });

  it('every group gets its own label', () => {
    const many = Array.from({ length: 60 }, (_, k) => c(`r${String(k).padStart(2, '0')}`, k / 100, list({ title: (i) => `Stück ${k} ${i}` })));
    const gs = groupTracklists(many, flat);
    expect(gs).toHaveLength(60);
    expect(new Set(gs.map((g) => g.label)).size).toBe(60);
    expect(new Set(Array.from({ length: 2000 }, (_, i) => groupLabel(i))).size).toBe(2000);
  });

  it('compares remote tracklists only: local alignment data does not change the groups', () => {
    const a = c('a', 0.01, list());
    const b = c('b', 0.02, list());
    const b2: GroupingCandidate = { ...b, evidence: { ...b.evidence, align: [], unmatchedLocal: [0, 1, 2], missingRemote: [3, 4] } };
    expect(shape(groupTracklists([a, b2], flat))).toEqual(shape(groupTracklists([a, b], flat)));
  });
});
