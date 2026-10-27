import { describe, it, expect } from 'vitest';
import { scoreRelease, MAX_ALIGN_TRACKS } from './scoring.js';
import { buildAlbumEvidence, buildCandidateEvidence, evidenceHash, stableJson, type EvidenceCandidate } from './evidence.js';

const tracks = (n: number, disc?: number) => Array.from({ length: n }, (_, i) => ({ title: `Song ${i + 1}`, duration: 200 + i, index: i, ...(disc ? { disc } : {}) }));
const remote = (n: number, over: Record<string, unknown> = {}) => ({
  source: 'musicbrainz' as const, title: 'Lichtung', artists: ['Ensemble Nord'],
  tracks: Array.from({ length: n }, (_, i) => ({ title: `Song ${i + 1}`, duration: 200 + i, medium: 1 })), ...over,
});
const scorable = (r: ReturnType<typeof remote>) => ({ id: 'r', releaseGroupId: 'g', title: r.title, artists: r.artists, source: r.source,
  tracks: r.tracks.map((t, i) => ({ title: t.title, duration: t.duration, index: i, medium: t.medium })) });

describe('candidate evidence', () => {
  it('records exactly what the scorer aligned (flat)', () => {
    const local = { artist: 'Ensemble Nord', title: 'Lichtung', tracks: tracks(5) };
    const r = remote(6);
    const s = scoreRelease(local, scorable(r));
    const ev = buildCandidateEvidence(r, s, 5);
    expect(ev.align).toEqual(s.alignment.filter((a) => a.canonicalIndex !== null).map((a) => [a.localIndex, a.canonicalIndex, Math.round(a.distance * 10000) / 10000]));
    expect(ev.unmatchedLocal).toEqual([]);
    expect(ev.missingRemote).toEqual([5]);
    expect(ev.tracks[0]).toEqual([1, 'Song 1', 200]);
    expect(ev.capped).toBe(false);
  });

  it('Discogs tracks without durations are stored as null, not 0', () => {
    const r = remote(3, { source: 'discogs', tracks: [{ title: 'A', duration: 0 }, { title: 'B', duration: 0 }, { title: 'C', duration: 0 }] });
    const ev = buildCandidateEvidence(r, scoreRelease({ artist: 'x', title: 'y', tracks: tracks(3) }, scorable(r)), 3);
    expect(ev.tracks.map((t) => t[2])).toEqual([null, null, null]);
    expect(ev.tracks.map((t) => t[0])).toEqual([null, null, null]);
  });

  it('marks a candidate over the alignment cap and keeps it unaligned', () => {
    const r = remote(MAX_ALIGN_TRACKS + 1);
    const ev = buildCandidateEvidence(r, scoreRelease({ artist: 'x', title: 'y', tracks: tracks(3) }, scorable(r)), 3);
    expect(ev.capped).toBe(true);
    expect(ev.align).toEqual([]);
    expect(ev.unmatchedLocal).toEqual([0, 1, 2]);
  });

  it('keeps the remote facts', () => {
    const r = remote(2, { year: 2011, country: 'FI', barcode: '0123', label: 'Nordlabel', catalogNumber: 'NL-1', media: '2xCD', status: 'Official', mediumCount: 2 });
    const ev = buildCandidateEvidence(r, scoreRelease({ artist: 'x', title: 'y', tracks: tracks(2) }, scorable(r)), 2);
    expect(ev.remote).toEqual({ provider: 'musicbrainz', title: 'Lichtung', artists: ['Ensemble Nord'], year: 2011, country: 'FI', label: 'Nordlabel', catalogNumber: 'NL-1', barcode: '0123', media: '2xCD', mediumCount: 2, status: 'Official' });
  });
});

describe('album evidence', () => {
  it('keeps each title with its source and the year with its source', () => {
    const ev = buildAlbumEvidence({ artist: 'Ensemble Nord', title: 'Lichtung', titleSource: 'tag', year: 2011, yearSource: 'folder', discsKnown: true, discCount: 2,
      tracks: [{ disc: 1, title: 'Eins', titleSource: 'tag', duration: 200.4 }, { disc: 2, title: '02 zwei', titleSource: 'filename', duration: 0 }] });
    expect(ev).toEqual({ v: 1, artist: 'Ensemble Nord', title: 'Lichtung', titleSource: 'tag', year: 2011, yearSource: 'folder', discsKnown: true, discCount: 2,
      tracks: [{ i: 0, disc: 1, title: 'Eins', titleSource: 'tag', durS: 200 }, { i: 1, disc: 2, title: '02 zwei', titleSource: 'filename', durS: null }] });
  });

  it('represents an album titled after its folder, and an unknown title source', () => {
    const ev = buildAlbumEvidence({ artist: '', title: 'Lichtung', titleSource: 'folder', year: null, yearSource: null, discsKnown: false, discCount: null, tracks: [] });
    expect(ev.titleSource).toBe('folder');
    const bare = buildAlbumEvidence({ artist: 'a', title: 't', year: null, yearSource: null, discsKnown: false, discCount: null, tracks: [] });
    expect(bare.titleSource).toBeNull();
  });

  it('keeps only its own fields, never paths a caller object carries', () => {
    const input = { artist: 'a', title: 't', titleSource: 'tag' as const, year: null, yearSource: null, discsKnown: false, discCount: null,
      dirPaths: ['some/folder'], tracks: [{ title: 'x', titleSource: 'tag' as const, duration: 100, relPath: 'some/folder/01 x.flac' }] };
    expect(JSON.stringify(buildAlbumEvidence(input))).not.toContain('some/folder');
  });
});

describe('evidence and score agree', () => {
  it('records the per-disc alignment of a multi-disc album', () => {
    const local = { artist: 'Ensemble Nord', title: 'Lichtung', tracks: [...tracks(2, 1), ...tracks(2, 2)].map((t, i) => ({ ...t, index: i })) };
    const r = remote(4, { tracks: [1, 1, 2, 2].map((m, i) => ({ title: `Song ${(i % 2) + 1}`, duration: 200 + (i % 2), medium: m })) });
    const s = scoreRelease(local, scorable(r));
    const ev = buildCandidateEvidence(r, s, 4);
    expect(ev.align.map((a) => [a[0], a[1]])).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
    expect(ev.tracks.map((t) => t[0])).toEqual([1, 1, 2, 2]);
  });

  it('lists local tracks the scorer left unpaired', () => {
    const r = remote(2);
    const s = scoreRelease({ artist: 'x', title: 'y', tracks: tracks(4) }, scorable(r));
    const ev = buildCandidateEvidence(r, s, 4);
    expect(ev.align).toHaveLength(2);
    expect(ev.unmatchedLocal).toHaveLength(2);
    expect([...ev.align.map((a) => a[0]), ...ev.unmatchedLocal].sort()).toEqual([0, 1, 2, 3]);
    expect(ev.missingRemote).toEqual([]);
  });

  it('a candidate exactly at the cap is aligned, not capped', () => {
    const r = remote(MAX_ALIGN_TRACKS);
    const ev = buildCandidateEvidence(r, scoreRelease({ artist: 'x', title: 'y', tracks: tracks(3) }, scorable(r)), 3);
    expect(ev.capped).toBe(false);
    expect(ev.align).toHaveLength(3);
  });
});

describe('evidenceHash', () => {
  const album = buildAlbumEvidence({ artist: 'a', title: 't', year: null, yearSource: null, discsKnown: false, discCount: null, tracks: [] });
  const c = (id: string, d: number): EvidenceCandidate => ({ releaseId: id, distance: d, acoustidCoverage: null, evidence: null });
  it('does not depend on candidate order or object key order', () => {
    expect(evidenceHash(album, [c('a', 0.1), c('b', 0.2)])).toBe(evidenceHash(album, [c('b', 0.2), c('a', 0.1)]));
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('changes when a candidate goes or its distance moves', () => {
    const h = evidenceHash(album, [c('a', 0.1), c('b', 0.2)]);
    expect(evidenceHash(album, [c('a', 0.1)])).not.toBe(h);
    expect(evidenceHash(album, [c('a', 0.1), c('b', 0.21)])).not.toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('ignores properties outside the evidence types and float noise below 4 decimals', () => {
    const h = evidenceHash(album, [c('a', 0.1)]);
    const row = { ...c('a', 0.1 + 1e-9), id: 'candidate-row-1', createdAt: '2026-01-01T00:00:00Z', excluded: false };
    expect(evidenceHash({ ...album, id: 'album-row' } as typeof album, [row])).toBe(h);
  });
  it('does not depend on key order inside the album or the evidence', () => {
    const r = remote(2);
    const ev = buildCandidateEvidence(r, scoreRelease({ artist: 'x', title: 'y', tracks: tracks(2) }, scorable(r)), 2);
    const reversed = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).reverse()) as T;
    const cand = (e: typeof ev): EvidenceCandidate => ({ releaseId: 'a', distance: 0.1, acoustidCoverage: 0.5, evidence: e });
    expect(evidenceHash(reversed(album), [cand({ ...reversed(ev), remote: reversed(ev.remote) })])).toBe(evidenceHash(album, [cand(ev)]));
  });
  it('changes when a source, a remote fact or the coverage changes', () => {
    const h = evidenceHash(album, [c('a', 0.1)]);
    expect(evidenceHash({ ...album, titleSource: 'folder' }, [c('a', 0.1)])).not.toBe(h);
    expect(evidenceHash(album, [{ ...c('a', 0.1), acoustidCoverage: 0.5 }])).not.toBe(h);
    const r = remote(2);
    const ev = buildCandidateEvidence(r, scoreRelease({ artist: 'x', title: 'y', tracks: tracks(2) }, scorable(r)), 2);
    const he = evidenceHash(album, [{ ...c('a', 0.1), evidence: ev }]);
    expect(evidenceHash(album, [{ ...c('a', 0.1), evidence: { ...ev, remote: { ...ev.remote, label: 'Other' } } }])).not.toBe(he);
  });
});
