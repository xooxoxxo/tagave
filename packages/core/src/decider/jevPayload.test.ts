import { describe, it, expect } from 'vitest';
import { buildAlbumEvidence, type AlbumEvidence, type CandidateEvidence, type TitleSource } from '../matching/evidence.js';
import { groupTracklists, type TracklistGroup } from './grouping.js';
import { buildJevRequest, NotSendableError, questionName, requestBytes } from './jevPayload.js';

const album = (titleSource: 'tag' | 'filename' | 'none', yearSource: 'tag' | 'folder' | null) => buildAlbumEvidence({
  artist: 'Ensemble Nord', title: 'Lichtung', titleSource: 'tag', year: 1999, yearSource, discsKnown: false, discCount: null,
  tracks: [{ title: titleSource === 'tag' ? 'Morgenrot' : '01 zz-private-file-token', titleSource, duration: 245 }, { title: 'Unter Eis', titleSource: 'tag', duration: 0 }],
});
const cand = (id: string, distance: number, provider: 'musicbrainz' | 'discogs', titles: string[], durs: Array<number | null>): { releaseId: string; distance: number; evidence: CandidateEvidence } => ({
  releaseId: id, distance,
  evidence: { v: 1, remote: { provider, title: 'Lichtung', artists: ['Ensemble Nord'], year: 2011, country: 'FI', label: 'Nordlabel', catalogNumber: 'NL-1', barcode: '0123', media: 'CD', mediumCount: 1, status: provider === 'musicbrainz' ? 'Official' : null },
    tracks: titles.map((t, i) => [1, t, durs[i] ?? null]), align: [[0, 0, 0.01], [1, 1, 0]], unmatchedLocal: [], missingRemote: [], capped: false },
});
const groups = groupTracklists([
  cand('mb', 0.05, 'musicbrainz', ['Morgenrot', 'Unter Eis'], [245, 300]),
  cand('dg', 0.04, 'discogs', ['Morgenrot', 'Unter Eis'], [null, null]),
  cand('live', 0.2, 'musicbrainz', ['Morgenrot (Live)', 'Unter Eis (Live)'], [260, 320]),
], { discsKnown: false });

describe('buildJevRequest', () => {
  it('matches the snapshot (the exact payload the owner is shown)', () => {
    expect(buildJevRequest(album('tag', 'tag'), groups, 'jev-latest')).toMatchSnapshot();
  });

  it('asks one yes/no question per group, all over one shared state', () => {
    const r = buildJevRequest(album('tag', 'tag'), groups, 'jev-latest');
    expect(Object.keys(r.questions)).toEqual(['is_A', 'is_B']);
    expect(Object.keys(r.state.tracklists)).toEqual(['A', 'B']);
    expect(r.questions[questionName('B')]!.instructions).toContain('tracklist B (state.tracklists.B)');
    expect(r.state.tracklists['A']!.editions.map((e) => e.source)).toEqual(['MusicBrainz', 'Discogs']);
  });

  it('a title from a file name goes out as "track N", never the name', () => {
    const r = buildJevRequest(album('filename', 'tag'), groups, 'jev-latest');
    expect(r.state.local.tracks[0]!.title).toBe('track 1');
    expect(JSON.stringify(r)).not.toContain('zz-private-file-token');
  });

  it('a generated title goes out as "track N" too', () => {
    expect(buildJevRequest(album('none', 'tag'), groups, 'jev-latest').state.local.tracks[0]!.title).toBe('track 1');
  });

  it('a year from the folder goes out as "year unknown"; a tag year as a number', () => {
    expect(buildJevRequest(album('tag', 'folder'), groups, 'm').state.local.year).toBe('year unknown');
    expect(buildJevRequest(album('tag', null), groups, 'm').state.local.year).toBe('year unknown');
    expect(buildJevRequest(album('tag', 'tag'), groups, 'm').state.local.year).toBe(1999);
  });

  it('an album whose every title came from file names is still a complete request', () => {
    const ev = buildAlbumEvidence({ artist: 'Ensemble Nord', title: 'Lichtung', titleSource: 'tag', year: null, yearSource: null, discsKnown: false, discCount: null,
      tracks: [{ title: 'a-name', titleSource: 'filename', duration: 1 }, { title: 'b-name', titleSource: 'filename', duration: 2 }] });
    const r = buildJevRequest(ev, groups, 'm');
    expect(r.state.local.tracks.map((t) => t.title)).toEqual(['track 1', 'track 2']);
    expect(JSON.stringify(r)).not.toMatch(/a-name|b-name/);
  });

  it('carries no ids, sources or paths', () => {
    const text = JSON.stringify(buildJevRequest(album('tag', 'tag'), groups, 'm'));
    for (const forbidden of ['"mb"', '"dg"', 'mb_search', 'releaseId', '/']) expect(text).not.toContain(forbidden);
  });

  it('pairs are 1-based and lengths m:ss; an unknown length is null', () => {
    const r = buildJevRequest(album('tag', 'tag'), groups, 'm');
    expect(r.state.tracklists['A']!.pairing.pairs).toEqual([[1, 1], [2, 2]]);
    expect(r.state.local.tracks.map((t) => t.length)).toEqual(['4:05', null]);
  });

  it('measures its size in bytes', () => {
    const r = buildJevRequest(album('tag', 'tag'), groups, 'm');
    expect(requestBytes(r)).toBe(Buffer.byteLength(JSON.stringify(r), 'utf8'));
  });
});

describe('buildJevRequest privacy', () => {
  it.each<TitleSource | null>(['folder', 'filename', 'none', null])('refuses an album whose title source is %s', (src) => {
    const ev = { ...album('tag', 'tag'), titleSource: src };
    expect(() => buildJevRequest(ev, groups, 'm')).toThrow(NotSendableError);
    try { buildJevRequest(ev, groups, 'm'); } catch (e) { expect((e as NotSendableError).reason).toBe('album_title'); }
  });

  it('no value from a file name or a folder name appears anywhere in the request', () => {
    const ev = buildAlbumEvidence({ artist: 'Ensemble Nord', title: 'Lichtung', titleSource: 'tag', year: 1777, yearSource: 'folder', discsKnown: false, discCount: null,
      tracks: [
        { title: 'zzfile-marker-91', titleSource: 'filename', duration: 245 },
        { title: 'zzfolder-marker-37', titleSource: 'folder', duration: 300 },
        { title: 'zznone-marker-55', titleSource: 'none', duration: 300 },
        { title: 'zznull-marker-12', titleSource: null, duration: 300 },
      ] });
    const four = groupTracklists([cand('zzrelease-id-marker', 0.1, 'musicbrainz', ['Morgenrot', 'Unter Eis', 'Nachtfahrt', 'Ausklang'], [245, 300, 300, 300])], { discsKnown: false });
    const text = JSON.stringify(buildJevRequest(ev, four, 'm'));
    for (const marker of ['zzfile-marker-91', 'zzfolder-marker-37', 'zznone-marker-55', 'zznull-marker-12', '1777', 'zzrelease-id-marker', 'musicbrainz', 'discogs', 'barcode', '0123']) {
      expect(text).not.toContain(marker);
    }
    expect(JSON.parse(text).state.local.tracks.map((t: { title: string }) => t.title)).toEqual(['track 1', 'track 2', 'track 3', 'track 4']);
  });
});

describe('buildJevRequest shape', () => {
  it('pins the exact JSON text, key order included', () => {
    expect(JSON.stringify(buildJevRequest(album('tag', 'tag'), groups, 'jev-latest'))).toMatchSnapshot();
  });

  it('is byte-identical for the same input, whatever the group or member order', () => {
    const a = JSON.stringify(buildJevRequest(album('tag', 'tag'), groups, 'm'));
    const shuffled: TracklistGroup[] = [...groups].reverse().map((g) => ({ ...g, members: [...g.members].reverse() }));
    expect(JSON.stringify(buildJevRequest(album('tag', 'tag'), shuffled, 'm'))).toBe(a);
    expect(JSON.stringify(buildJevRequest(album('tag', 'tag'), groups, 'm'))).toBe(a);
  });

  it('orders labels past Z as A..Z, AA', () => {
    const many: TracklistGroup[] = ['AA', 'B', 'A', 'Z'].map((label) => ({ ...groups[0]!, label }));
    const r = buildJevRequest(album('tag', 'tag'), many, 'm');
    expect(Object.keys(r.state.tracklists)).toEqual(['A', 'B', 'Z', 'AA']);
    expect(Object.keys(r.questions)).toEqual(['is_A', 'is_B', 'is_Z', 'is_AA']);
  });

  it('refuses duplicate group labels', () => {
    expect(() => buildJevRequest(album('tag', 'tag'), [groups[0]!, groups[0]!], 'm')).toThrow(/label/);
  });

  it('numbers unpaired tracks from 1 and checks every index against its tracklist', () => {
    const base = cand('x', 0.1, 'musicbrainz', ['Morgenrot', 'Unter Eis', 'Extra'], [245, 300, 100]);
    const ev: CandidateEvidence = { ...base.evidence, align: [[0, 0, 0]], unmatchedLocal: [1], missingRemote: [1, 2] };
    const g = (e: CandidateEvidence): TracklistGroup[] => [{ label: 'A', anchor: { ...base, evidence: e }, members: [{ ...base, evidence: e }], closed: false }];
    const p = buildJevRequest(album('tag', 'tag'), g(ev), 'm').state.tracklists['A']!.pairing;
    expect(p).toEqual({ pairs: [[1, 1]], localUnpaired: [2], remoteUnpaired: [2, 3] });
    expect(() => buildJevRequest(album('tag', 'tag'), g({ ...ev, align: [[2, 0, 0]] }), 'm')).toThrow(RangeError);
    expect(() => buildJevRequest(album('tag', 'tag'), g({ ...ev, align: [[0, 3, 0]] }), 'm')).toThrow(RangeError);
    expect(() => buildJevRequest(album('tag', 'tag'), g({ ...ev, unmatchedLocal: [-1] }), 'm')).toThrow(RangeError);
    expect(() => buildJevRequest(album('tag', 'tag'), g({ ...ev, missingRemote: [1.5] }), 'm')).toThrow(RangeError);
  });

  it('sends disc numbers when the album knows its discs and the release has several', () => {
    const ev: AlbumEvidence = buildAlbumEvidence({ artist: 'Ensemble Nord', title: 'Lichtung', titleSource: 'tag', year: 1999, yearSource: 'tag', discsKnown: true, discCount: 2,
      tracks: [{ disc: 1, title: 'Morgenrot', titleSource: 'tag', duration: 245 }, { disc: 2, title: 'Unter Eis', titleSource: 'tag', duration: 300 }] });
    const base = cand('x', 0.1, 'musicbrainz', ['Morgenrot', 'Unter Eis'], [245, 300]);
    const e: CandidateEvidence = { ...base.evidence, remote: { ...base.evidence.remote, mediumCount: 2 }, tracks: [[1, 'Morgenrot', 245], [2, 'Unter Eis', 300]] };
    const r = buildJevRequest(ev, [{ label: 'A', anchor: { ...base, evidence: e }, members: [{ ...base, evidence: e }], closed: false }], 'm');
    expect(r.state.local.discs).toBe(2);
    expect(r.state.local.tracks.map((t) => t.disc)).toEqual([1, 2]);
    expect(r.state.tracklists['A']!.tracks.map((t) => t.disc)).toEqual([1, 2]);
  });

  it('counts UTF-8 bytes, not characters', () => {
    const ev = buildAlbumEvidence({ artist: 'Ensemble Nord', title: 'Lichtung', titleSource: 'tag', year: 1999, yearSource: 'tag', discsKnown: false, discCount: null,
      tracks: [{ title: 'Måneskinn – 夜', titleSource: 'tag', duration: 245 }, { title: 'Unter Eis', titleSource: 'tag', duration: 300 }] });
    const r = buildJevRequest(ev, groups, 'm');
    const text = JSON.stringify(r);
    expect(requestBytes(r)).toBe(Buffer.byteLength(text, 'utf8'));
    expect(requestBytes(r)).toBeGreaterThan(text.length);
  });

  it('formats lengths as m:ss', () => {
    const ev = buildAlbumEvidence({ artist: 'A', title: 'T', titleSource: 'tag', year: null, yearSource: null, discsKnown: false, discCount: null,
      tracks: [{ title: 'a', titleSource: 'tag', duration: 59.6 }, { title: 'b', titleSource: 'tag', duration: 3600 }] });
    expect(buildJevRequest(ev, groups, 'm').state.local.tracks.map((t) => t.length)).toEqual(['1:00', '60:00']);
  });
});
