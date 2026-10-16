import { describe, expect, it } from 'vitest';
import { CAPABILITY_DATA, encodeCursor } from 'music-connections';
import { albumRef, collectionFormats, discogsFormatKind, identityProvenance, mapRating, parseSince } from './mcFeeds.js';

const MBID = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';

describe('mapRating (tagave 0.5–5 → protocol 0–10)', () => {
  it('doubles the stored value and keeps it raw', () => {
    expect(mapRating('3.5')).toEqual({ rating: 7, rating_raw: '3.5', scale: '0-5' });
    expect(mapRating('4.0')).toEqual({ rating: 8, rating_raw: '4', scale: '0-5' });
    expect(mapRating('0.5')).toEqual({ rating: 1, rating_raw: '0.5', scale: '0-5' });
    expect(mapRating(5)).toEqual({ rating: 10, rating_raw: '5', scale: '0-5' });
  });

  it('a cleared rating has no value: the key becomes a tombstone, never a 0', () => {
    expect(mapRating(null)).toBeNull();
    expect(mapRating(undefined)).toBeNull();
    expect(mapRating('')).toBeNull();
    expect(mapRating('0')).toBeNull();
    expect(mapRating('7')).toBeNull();
  });

  it('a mapped rating is a valid ratings payload', () => {
    const data = { album: albumRef({ rgMbid: MBID, artist: 'A', title: 'T' }), ...mapRating('3.5')!, favorite: false, rated_at: new Date().toISOString() };
    expect(CAPABILITY_DATA.ratings.safeParse(data).success).toBe(true);
  });
});

describe('format mapping', () => {
  it('maps Discogs format names to kinds', () => {
    expect(discogsFormatKind('Vinyl')).toBe('vinyl');
    expect(discogsFormatKind('CD')).toBe('cd');
    expect(discogsFormatKind('Cassette')).toBe('cassette');
    expect(discogsFormatKind('File')).toBe('digital');
    expect(discogsFormatKind('Box Set')).toBe('other');
    expect(discogsFormatKind('CDr')).toBe('other');
    expect(discogsFormatKind(undefined)).toBe('other');
  });

  it('puts the Discogs descriptions in detail and local codecs as digital', () => {
    const copies = [
      [{ name: 'Vinyl', qty: 2, descriptions: ['LP', 'Album', 'Reissue'] }],
      [{ name: 'CD', descriptions: [] }],
      [{ name: 'Vinyl', descriptions: ['LP', 'Album', 'Reissue'] }], // a second copy: one entry
    ];
    expect(collectionFormats(copies, ['FLAC', 'MP3', null])).toEqual([
      { kind: 'vinyl', detail: 'LP, Album, Reissue' },
      { kind: 'cd' },
      { kind: 'digital', detail: 'FLAC' },
      { kind: 'digital', detail: 'MP3' },
      { kind: 'digital' },
    ]);
  });

  it('a copy Discogs gave no formats still counts', () => {
    expect(collectionFormats([[]], [])).toEqual([{ kind: 'other' }]);
    expect(collectionFormats([null], [])).toEqual([{ kind: 'other' }]);
  });

  it('caps the detail and the list at the schema bounds', () => {
    const long = [{ name: 'Vinyl', descriptions: ['x'.repeat(300)] }];
    expect(collectionFormats([long], [])[0]!.detail).toHaveLength(120);
    expect(collectionFormats([], Array.from({ length: 80 }, (_, i) => `c${i}`))).toHaveLength(50);
  });
});

describe('album identity', () => {
  it('a Discogs copy with no MBID keeps its Discogs ids and names', () => {
    const ref = albumRef({ rgMbid: null, discogsMasterId: 12345, discogsReleaseId: '678', artist: 'Some Band', title: 'Some Album' });
    expect(ref).toEqual({ rg_mbid: null, discogs_master_id: 12345, discogs_release_id: 678, artist: 'Some Band', title: 'Some Album' });
    const data = { album: ref, formats: collectionFormats([[{ name: 'Vinyl', descriptions: ['LP'] }]], []) };
    expect(CAPABILITY_DATA.collection.safeParse(data).success).toBe(true);
  });

  it('drops ids that are not valid, never the album', () => {
    expect(albumRef({ rgMbid: 'not-a-uuid', releaseMbid: '', discogsMasterId: 0, artist: null, title: null }))
      .toEqual({ rg_mbid: null, artist: '', title: '' });
  });

  it('provenance: confirmed is manual, tag MBIDs embedded, else auto with 1 − distance', () => {
    expect(identityProvenance({ status: 'confirmed', source: 'mb_search', distance: '0.3', embeddedMbid: null, releaseMbid: MBID }))
      .toEqual({ provenance: 'manual', confidence: 1 });
    expect(identityProvenance({ status: 'auto', source: 'mb_search', distance: '0.1', embeddedMbid: MBID.toUpperCase(), releaseMbid: MBID }))
      .toEqual({ provenance: 'embedded', confidence: 1 });
    expect(identityProvenance({ status: 'auto', source: 'mbid', distance: '0.2', embeddedMbid: null, releaseMbid: MBID }))
      .toEqual({ provenance: 'embedded', confidence: 1 });
    expect(identityProvenance({ status: 'auto', source: 'mb_search', distance: '0.1250', embeddedMbid: null, releaseMbid: MBID }))
      .toEqual({ provenance: 'auto', confidence: 0.875 });
    expect(identityProvenance({ status: null, source: null, distance: null, embeddedMbid: null, releaseMbid: null }))
      .toEqual({ provenance: 'auto', confidence: 0 });
  });
});

describe('parseSince', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  it('no cursor is a full snapshot', () => {
    expect(parseSince(undefined, now)).toEqual({ ok: true, after: null });
    expect(parseSince('', now)).toEqual({ ok: true, after: null });
  });
  it('a valid cursor round-trips', () => {
    const c = { t: '2026-10-15T08:00:00.123456Z', id: '42' };
    expect(parseSince(encodeCursor(c), now)).toEqual({ ok: true, after: c });
  });
  it('garbage, an impossible date or a foreign id is 400', () => {
    expect(parseSince('%%%garbage', now)).toEqual({ ok: false, status: 400 });
    expect(parseSince(encodeCursor({ t: '2026-02-31T00:00:00Z', id: '1' }), now)).toEqual({ ok: false, status: 400 });
    expect(parseSince(encodeCursor({ t: '2026-10-15T00:00:00Z', id: 'abc' }), now)).toEqual({ ok: false, status: 400 });
    expect(parseSince(['a'], now)).toEqual({ ok: false, status: 400 });
  });
  it('a cursor older than the 90 days of tombstones is 410', () => {
    expect(parseSince(encodeCursor({ t: '2026-07-01T00:00:00Z', id: '1' }), now)).toEqual({ ok: false, status: 410 });
  });
});
