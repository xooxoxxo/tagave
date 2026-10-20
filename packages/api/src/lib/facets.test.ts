/**
 * The review panel's view of an album.critic-scores@1 value: each review and
 * critic rating carries its outlet ("Pitchfork") and the app that relayed it
 * ("review-gatherer"), null for a source tagave reads itself (CritiqueBrainz),
 * beside the combined label older clients show.
 */
import { describe, expect, it } from 'vitest';
import { httpOnly, reviewsBundleSchema } from '@tagave/shared';
import { criticScoreView } from './facets.js';

const criticScoresSchema = reviewsBundleSchema.shape.criticScores.unwrap();

describe('criticScoreView', () => {
  it('a linked app’s value: the publication is the outlet, the app is via', () => {
    const view = criticScoreView({
      source: { module: 'mc', ref: 'link-1', label: 'review-gatherer' },
      data: {
        aggregate: { score: 8.7, tier: 'A', review_count: 3 },
        reviews: [
          { source: 'Pitchfork', score: 9.1, score_raw: '9.1', url: 'https://pitchfork.com/r/1', published_at: null },
          { source: 'The Quietus', score: null, score_raw: 'unscored', url: 'https://thequietus.com/1', published_at: null },
        ],
        critic_ratings: [{ outlet: 'Metacritic', score: 8.6, score_raw: '86' }],
      },
      updatedAt: null,
    });
    expect(view.reviews.map((r) => [r.outlet, r.via, r.label])).toEqual([
      ['Pitchfork', 'review-gatherer', 'Pitchfork (via review-gatherer)'],
      ['The Quietus', 'review-gatherer', 'The Quietus (via review-gatherer)'],
    ]);
    expect(view.criticRatings).toEqual([{ label: 'Metacritic (via review-gatherer)', outlet: 'Metacritic', via: 'review-gatherer', score: 8.6, scoreRaw: '86' }]);
    expect(view.aggregate).toEqual({ score: 8.7, tier: 'A', reviewCount: 3 });
    expect(criticScoresSchema.safeParse({ available: true, values: [view] }).success).toBe(true);
  });

  it('a built-in source: the outlet is the source, via is null, the label is the outlet alone', () => {
    const view = criticScoreView({
      source: { module: 'reviews', ref: null, label: 'CritiqueBrainz' },
      data: {
        aggregate: { score: 8, tier: null, review_count: 1 },
        reviews: [{ source: 'CritiqueBrainz', score: 8, score_raw: '80/100', url: 'https://critiquebrainz.org/review/1', published_at: null }],
        critic_ratings: [],
      },
      updatedAt: '2026-10-12T09:30:00.000Z',
    });
    expect(view.reviews).toEqual([{ label: 'CritiqueBrainz', outlet: 'CritiqueBrainz', via: null, score: 8, scoreRaw: '80/100', url: 'https://critiquebrainz.org/review/1', publishedAt: null }]);
    expect(criticScoresSchema.safeParse({ available: true, values: [view] }).success).toBe(true);
  });

  it('a link that is not http(s) never reaches the page; empty data reads as nothing', () => {
    const view = criticScoreView({
      source: { module: 'mc', ref: 'link-1', label: 'review-gatherer' },
      data: { reviews: [{ source: 'Pitchfork', score: 9, score_raw: '9', url: 'javascript:alert(1)', published_at: null }] },
      updatedAt: null,
    });
    expect(view.reviews[0]).toMatchObject({ outlet: 'Pitchfork', via: 'review-gatherer', url: null });
    expect(criticScoreView({ source: { module: 'mc', ref: null, label: 'x' }, data: null, updatedAt: null })).toMatchObject({ aggregate: null, reviews: [], criticRatings: [] });
  });

  it('httpOnly (shared): http(s) with a host passes; any other scheme, no host or whitespace is null', () => {
    expect(httpOnly('https://pitchfork.com/r/1')).toBe('https://pitchfork.com/r/1');
    expect(httpOnly('HTTP://example.org')).toBe('HTTP://example.org');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'https://', ' https://x.org', 'https://x.org/a b', '/relative', '', null, undefined]) expect(httpOnly(bad)).toBeNull();
  });
});
