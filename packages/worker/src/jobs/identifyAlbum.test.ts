/**
 * Pure helpers of the identify job: embedded-id extraction and the
 * fast-path verdict (XO-309).
 */
import { describe, it, expect } from 'vitest';
import { MATCHING_THRESHOLDS } from '@liner/core';
import { embeddedIdsOf, fastPathOutcome } from './identifyAlbum.js';

const MBID = '1cf9ebd6-6a5f-4592-8203-910f71b9ddb0';
const RG = '3c672f5d-8ffa-44e5-bbe5-68a9ec6759a7';

describe('embeddedIdsOf', () => {
  it('reads a string release id', () => {
    expect(embeddedIdsOf({ common: { musicbrainz_albumid: MBID } })).toEqual({ albumMbid: MBID });
  });

  it('takes the first element of an array-valued tag', () => {
    expect(embeddedIdsOf({ common: { musicbrainz_albumid: [MBID, RG] } })).toEqual({ albumMbid: MBID });
  });

  it('lower-cases and trims the id', () => {
    expect(embeddedIdsOf({ common: { musicbrainz_albumid: ` ${MBID.toUpperCase()} ` } })).toEqual({ albumMbid: MBID });
  });

  it('ignores values that are not a UUID', () => {
    expect(embeddedIdsOf({ common: { musicbrainz_albumid: 'not-an-id' } })).toEqual({});
    expect(embeddedIdsOf({ common: { musicbrainz_albumid: 42 } })).toEqual({});
  });

  it('reads the release-group id and the barcode', () => {
    expect(embeddedIdsOf({ common: { musicbrainz_releasegroupid: RG, barcode: ' 0123456789 ' } }))
      .toEqual({ rgMbid: RG, barcode: '0123456789' });
  });

  it('drops an empty barcode', () => {
    expect(embeddedIdsOf({ common: { barcode: '   ' } })).toEqual({});
  });

  it('tolerates missing tags', () => {
    expect(embeddedIdsOf(null)).toEqual({});
    expect(embeddedIdsOf(undefined)).toEqual({});
    expect(embeddedIdsOf({})).toEqual({});
  });
});

describe('fastPathOutcome', () => {
  it('is a hit for a perfect score with track parity', () => {
    expect(fastPathOutcome(0, 12, 12)).toBe('hit');
  });

  it('is a hit exactly at the strong threshold', () => {
    expect(fastPathOutcome(MATCHING_THRESHOLDS.strong, 12, 12)).toBe('hit');
  });

  it('is weak above the strong threshold', () => {
    expect(fastPathOutcome(MATCHING_THRESHOLDS.strong + 0.0001, 12, 12)).toBe('weak');
  });

  it('is weak when the track counts differ, however good the score', () => {
    expect(fastPathOutcome(0, 13, 12)).toBe('weak');
    expect(fastPathOutcome(0, 0, 12)).toBe('weak');
  });
});
