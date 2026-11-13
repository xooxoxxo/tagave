import { describe, it, expect } from 'vitest';
import { buildAlbumEvidence, evidenceHash, type CandidateEvidence, type EvidenceCandidate } from '../matching/evidence.js';
import { buildJevRequest, NotSendableError, requestBytes } from './jevPayload.js';
import { groupTracklists } from './grouping.js';
import { JEV_SPEC } from './jevSpec.js';
import { MAX_EDITIONS_PER_GROUP, MAX_GROUPS, WEAK_TOP_CANDIDATES, hashOf, jevPayloadFor, requestForAlbum, requestOptions } from './preview.js';

const album = (titleSource: 'tag' | 'folder' = 'tag') => buildAlbumEvidence({
  artist: 'Ensemble Nord', title: 'Lichtung', titleSource, year: 1999, yearSource: 'tag', discsKnown: false, discCount: null,
  tracks: [{ title: 'Morgenrot', titleSource: 'tag', duration: 245 }, { title: 'Unter Eis', titleSource: 'tag', duration: 300 }],
});
const ev = (titles: string[], o: { capped?: boolean } = {}): CandidateEvidence => ({
  v: 1,
  remote: { provider: 'musicbrainz', title: 'Lichtung', artists: ['Ensemble Nord'], year: 2011, country: 'FI', label: 'Nordlabel', catalogNumber: 'NL-1', barcode: null, media: 'CD', mediumCount: 1, status: 'Official' },
  tracks: titles.map((t, i) => [1, t, 245 + i * 55]), align: [[0, 0, 0.01], [1, 1, 0]], unmatchedLocal: [], missingRemote: titles.map((_, i) => i).filter((i) => i > 1),
  capped: o.capped ?? false,
});
const cand = (releaseId: string, distance: number, titles = ['Morgenrot', 'Unter Eis'], o: { capped?: boolean } = {}): EvidenceCandidate => ({
  releaseId, distance, acoustidCoverage: null, evidence: ev(titles, o),
});
/** n distinct tracklists: k extra bonus tracks each, so none fits another */
const distinct = (n: number, base = 0.05): EvidenceCandidate[] =>
  Array.from({ length: n }, (_, k) => cand(`r${k}`, base + k * 0.01, ['Morgenrot', 'Unter Eis', ...Array.from({ length: k }, (_, j) => `Bonus ${k}-${j}`)]));

describe('requestForAlbum', () => {
  it('groups the candidates and builds exactly the request buildJevRequest gives for them', () => {
    const cands = [cand('a', 0.05), cand('b', 0.04), cand('c', 0.2, ['Morgenrot', 'Unter Eis', 'Bonus'])];
    const r = requestForAlbum(album(), cands, { model: 'jev-latest' });
    const groups = groupTracklists(cands.map((c) => ({ releaseId: c.releaseId, distance: c.distance, evidence: c.evidence! })), { discsKnown: false }, JEV_SPEC.grouping);
    expect(r.request).toEqual(buildJevRequest(album(), groups, 'jev-latest'));
    expect(r.bytes).toBe(requestBytes(r.request));
    expect(r.bytes).toBe(Buffer.byteLength(JSON.stringify(r.request), 'utf8'));
    expect(r.labels).toEqual(['A', 'B']);
    expect(r.sent.map((g) => g.members.map((m) => m.releaseId))).toEqual([['b', 'a'], ['c']]);
  });

  it('sends each release once, at its best distance', () => {
    const r = requestForAlbum(album(), [cand('a', 0.08), cand('a', 0.05), cand('b', 0.06)], { model: 'm' });
    expect(r.candidates.map((c) => [c.releaseId, c.distance])).toEqual([['a', 0.05], ['b', 0.06]]);
  });

  it('shows at most eight groups and five editions of each; the decision still sees every group', () => {
    const many = requestForAlbum(album(), distinct(MAX_GROUPS + 2), { model: 'm' });
    expect(many.groups).toHaveLength(MAX_GROUPS + 2);
    expect(many.sent).toHaveLength(MAX_GROUPS);
    expect(Object.keys(many.request.questions)).toHaveLength(MAX_GROUPS);
    const editions = requestForAlbum(album(), Array.from({ length: 7 }, (_, k) => cand(`e${k}`, 0.05 + k * 0.001)), { model: 'm' });
    expect(editions.groups[0]!.members).toHaveLength(7);
    expect(editions.sent[0]!.members).toHaveLength(MAX_EDITIONS_PER_GROUP);
    expect(editions.request.state.tracklists['A']!.editions).toHaveLength(MAX_EDITIONS_PER_GROUP);
  });

  it('a weak album sends its best five candidates only', () => {
    const r = requestForAlbum(album(), distinct(7, 0.3), { model: 'm', weak: true });
    expect(r.candidates.map((c) => c.releaseId)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    expect(r.candidates).toHaveLength(WEAK_TOP_CANDIDATES);
  });

  it('refuses an album it may not send, with the reason', () => {
    const reason = (f: () => unknown) => {
      try { f(); } catch (err) { return err instanceof NotSendableError ? err.reason : `other: ${String(err)}`; }
      return 'sent';
    };
    expect(reason(() => requestForAlbum(album('folder'), [cand('a', 0.05)], { model: 'm' }))).toBe('album_title');
    expect(reason(() => requestForAlbum(album(), [cand('a', 0.05, undefined, { capped: true })], { model: 'm' }))).toBe('capped');
    expect(reason(() => requestForAlbum(album(), [], { model: 'm' }))).toBe('no_candidates');
    expect(reason(() => requestForAlbum(album(), [cand('a', 0.05), { ...cand('b', 0.06), evidence: null }], { model: 'm' }))).toBe('partial_evidence');
    expect(reason(() => requestForAlbum(album(), [cand('a', 0.05)], { model: 'm', partial: true }))).toBe('partial_evidence');
    const small = (() => { try { requestForAlbum(album(), [cand('a', 0.05)], { model: 'm', maxRequestBytes: 100 }); } catch (err) { return err; } })();
    expect(small).toBeInstanceOf(NotSendableError);
    expect((small as NotSendableError).reason).toBe('too_large');
    expect((small as NotSendableError).bytes).toBe(requestForAlbum(album(), [cand('a', 0.05)], { model: 'm' }).bytes);
    expect(reason(() => requestForAlbum(album(), [cand('a', 0.05)], { model: 'm', maxRequestBytes: 1_000_000 }))).toBe('sent');
  });

  it('hashOf is the evidence hash of the album and its candidates', () => {
    const cands = [cand('a', 0.05), cand('b', 0.06)];
    expect(hashOf({ album: album(), candidates: cands })).toBe(evidenceHash(album(), cands));
  });

  it('requestOptions: the options a run of a population (and its preview) builds with', () => {
    const config = { model: 'jev-latest', maxRequestBytes: 4096 };
    expect(requestOptions('needs_review', config, { partial: false })).toEqual({ model: 'jev-latest', weak: false, partial: false, maxRequestBytes: 4096 });
    expect(requestOptions('weak', { model: 'm', maxRequestBytes: null }, { partial: true })).toEqual({ model: 'm', weak: true, partial: true, maxRequestBytes: null });
  });

  it('jevPayloadFor is requestForAlbum with the request as the payload', () => {
    const cands = [cand('a', 0.05), cand('c', 0.2, ['Morgenrot', 'Unter Eis', 'Bonus'])];
    const r = requestForAlbum(album(), cands, { model: 'm' });
    const p = jevPayloadFor(album(), cands, { model: 'm' });
    expect(p.payload).toEqual(r.request);
    expect(p).toMatchObject({ bytes: r.bytes, labels: r.labels });
    expect(p.groups).toEqual(r.groups);
  });
});
