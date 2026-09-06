/**
 * CritiqueBrainz client tests (spec REV-1). Fixture: live response for the
 * OK Computer release group, captured 2026-09-06.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CritiqueBrainzClient, critiqueBrainzLicense, mapCritiqueBrainzReview } from './critiquebrainz.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf-8'));
const ctx = { priority: 'background' as const };

describe('critiqueBrainzLicense', () => {
  it('normalises the two CritiqueBrainz licences', () => {
    expect(critiqueBrainzLicense('CC BY-SA-3.0', undefined)).toBe('CC BY-SA 3.0');
    expect(critiqueBrainzLicense('CC BY-NC-SA-3.0', undefined)).toBe('CC BY-NC-SA 3.0');
    expect(critiqueBrainzLicense('cc-by-sa-3.0', undefined)).toBe('CC BY-SA 3.0');
  });

  it('falls back to the full name, then to an explicit unspecified marker', () => {
    expect(critiqueBrainzLicense('something-new', 'Some Licence 4.0')).toBe('Some Licence 4.0');
    expect(critiqueBrainzLicense(undefined, undefined)).toBe('CritiqueBrainz review (licence unspecified)');
  });
});

describe('mapCritiqueBrainzReview', () => {
  const fixture = loadFixture('critiquebrainz_reviews_okcomputer.json');

  it('maps a live review with author, licence, date, text and source link', () => {
    const r = mapCritiqueBrainzReview(fixture.reviews[0]);
    expect(r).not.toBeNull();
    expect(r?.source).toBe('critiquebrainz');
    expect(r?.sourceId).toBe('c508a8ec-1bd0-4f92-bcd8-581a2cd2e75f');
    expect(r?.url).toBe('https://critiquebrainz.org/review/c508a8ec-1bd0-4f92-bcd8-581a2cd2e75f');
    expect(r?.author).toBe('Jon Lusk');
    expect(r?.license).toBe('CC BY-NC-SA 3.0');
    expect(r?.publishedAt?.toISOString().slice(0, 10)).toBe('2007-04-25');
    expect(r?.bodyText?.startsWith('As an occasional admirer')).toBe(true);
    expect(r?.excerpt?.length).toBeLessThanOrEqual(281);
    expect(r?.language).toBe('en');
    expect(r?.title).toBe('BBC');
    expect(r?.ratingScale).toBe(5);
  });

  it('maps every published review in the fixture', () => {
    const mapped = fixture.reviews.map(mapCritiqueBrainzReview).filter(Boolean);
    expect(mapped).toHaveLength(fixture.reviews.length);
  });

  it('drops drafts, hidden reviews and reviews without text or rating', () => {
    const base = fixture.reviews[0];
    expect(mapCritiqueBrainzReview({ ...base, is_draft: true })).toBeNull();
    expect(mapCritiqueBrainzReview({ ...base, is_hidden: true })).toBeNull();
    expect(mapCritiqueBrainzReview({ ...base, text: null, rating: null })).toBeNull();
    expect(mapCritiqueBrainzReview({ ...base, text: null, rating: 4 })?.ratingRaw).toBe(4);
    expect(mapCritiqueBrainzReview('garbage')).toBeNull();
  });
});

describe('CritiqueBrainzClient', () => {
  it('queries by release-group MBID with the User-Agent and maps the reviews', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return new Response(JSON.stringify(loadFixture('critiquebrainz_reviews_okcomputer.json')), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new CritiqueBrainzClient({ userAgent: 'Liner/test (+test)', fetchImpl });

    const reviews = await client.getReviewsForReleaseGroup('b1392450-e666-3926-a536-22c65f834433', ctx);

    expect(reviews).toHaveLength(loadFixture('critiquebrainz_reviews_okcomputer.json').reviews.length);
    expect(seenUrl).toContain('https://critiquebrainz.org/ws/1/review/?');
    expect(seenUrl).toContain('entity_id=b1392450-e666-3926-a536-22c65f834433');
    expect(seenUrl).toContain('entity_type=release_group');
    expect(seenUrl).toContain('limit=50');
    expect(seenHeaders['User-Agent']).toBe('Liner/test (+test)');
  });

  it('returns [] when the entity has no reviews (404) and throws a rate-limit error on 503', async () => {
    const notFound = new CritiqueBrainzClient({
      userAgent: 't',
      fetchImpl: (async () => new Response('{"description":"not found"}', { status: 404 })) as unknown as typeof fetch,
    });
    expect(await notFound.getReviewsForReleaseGroup('x', ctx)).toEqual([]);

    const limited = new CritiqueBrainzClient({
      userAgent: 't',
      fetchImpl: (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
    });
    await expect(limited.getReviewsForReleaseGroup('x', ctx)).rejects.toThrow(/503/);
  });
});
