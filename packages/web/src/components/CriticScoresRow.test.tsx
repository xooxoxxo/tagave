/**
 * The review panel's critic scores (the album.critic-scores facet): every
 * source labelled, CritiqueBrainz and each linked app; nothing when the
 * facet is unavailable.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReviewsBundle } from '@tagave/shared';
import { CriticScoresRow } from './ReviewsSection';

const bundle = (criticScores: ReviewsBundle['criticScores']): ReviewsBundle => ({
  releaseGroupId: '00000000-0000-4000-8000-000000000001', fetchedAt: null, gathering: false, external: [], links: [], clippings: [], own: null, listens: [],
  ...(criticScores ? { criticScores } : {}),
});

describe('CriticScoresRow', () => {
  it('labels each source and each review by where it came from', () => {
    const html = renderToStaticMarkup(<CriticScoresRow bundle={bundle({ available: true, values: [
      { source: { module: 'reviews', ref: null, label: 'CritiqueBrainz' }, aggregate: { score: 8, tier: null, reviewCount: 1 }, reviews: [], criticRatings: [], updatedAt: null },
      { source: { module: 'mc', ref: 'l1', label: 'review-gatherer' }, aggregate: { score: 8.7, tier: 'A', reviewCount: 2 },
        reviews: [{ label: 'Pitchfork (via review-gatherer)', score: 9.1, scoreRaw: '9.1', url: 'https://pitchfork.com/r/1', publishedAt: null }],
        criticRatings: [{ label: 'Metacritic (via review-gatherer)', score: 8.6, scoreRaw: '86' }], updatedAt: null },
    ] })} />);
    expect(html).toContain('Critic scores');
    expect(html).toContain('CritiqueBrainz');
    expect(html).toContain('8.7 / 10 · A · 2 reviews');
    expect(html).toContain('Pitchfork (via review-gatherer)');
    expect(html).toContain('Metacritic (via review-gatherer)');
    expect(html).toContain('href="https://pitchfork.com/r/1"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('shows nothing when no source is on or none has scores', () => {
    expect(renderToStaticMarkup(<CriticScoresRow bundle={bundle({ available: false, values: [] })} />)).toBe('');
    expect(renderToStaticMarkup(<CriticScoresRow bundle={bundle(undefined)} />)).toBe('');
  });
});
