/**
 * The review panel's critic scores (the album.critic-scores facet) as a
 * ledger: every source with its aggregate, each linked app's outlets under
 * it by their `outlet` name; nothing when the facet is unavailable.
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
  it('groups by source: the aggregate first, its outlets under it by their own name, each link in the row', () => {
    const html = renderToStaticMarkup(<CriticScoresRow bundle={bundle({ available: true, values: [
      { source: { module: 'reviews', ref: null, label: 'CritiqueBrainz' }, aggregate: { score: 8, tier: null, reviewCount: 1 },
        reviews: [{ label: 'CritiqueBrainz', outlet: 'CritiqueBrainz', via: null, score: 8, scoreRaw: '80/100', url: 'https://critiquebrainz.org/review/1', publishedAt: null }], criticRatings: [], updatedAt: null },
      { source: { module: 'mc', ref: 'l1', label: 'review-gatherer' }, aggregate: { score: 8.7, tier: 'A', reviewCount: 2 },
        reviews: [{ label: 'Pitchfork (via review-gatherer)', outlet: 'Pitchfork', via: 'review-gatherer', score: 9.1, scoreRaw: '9.1', url: 'https://pitchfork.com/r/1', publishedAt: null }],
        criticRatings: [{ label: 'Metacritic (via review-gatherer)', outlet: 'Metacritic', via: 'review-gatherer', score: 8.6, scoreRaw: '86' }], updatedAt: null },
    ] })} />);
    const text = html.replace(/<[^>]+>/g, '');
    expect(text).toContain('Critic scores');
    // each source heads its group with its aggregate; tier and count under its name
    expect(text).toMatch(/CritiqueBrainz8\.0 \/ 10/);
    expect(text).toMatch(/review-gathererA · 2 reviews8\.7 \/ 10/);
    // the outlets by their own name (the group says where they came from), never parsed from the label
    expect(text).toMatch(/Pitchfork9\.1 \/ 10/);
    expect(text).toMatch(/Metacritic8\.6 \/ 10/);
    expect(text).not.toContain('(via review-gatherer)');
    // CritiqueBrainz's own review is its aggregate's link, not an outlet row of its own
    expect(html.match(/>CritiqueBrainz</g)).toHaveLength(1);
    expect(html).toContain('href="https://critiquebrainz.org/review/1"');
    // the link keeps the full label as its name, opens elsewhere safely
    expect(html).toContain('aria-label="Pitchfork (via review-gatherer): the review"');
    expect(html).toContain('href="https://pitchfork.com/r/1"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('an unscored outlet says so in the score column and keeps its link', () => {
    const html = renderToStaticMarkup(<CriticScoresRow bundle={bundle({ available: true, values: [
      { source: { module: 'mc', ref: 'l1', label: 'review-gatherer' }, aggregate: { score: null, tier: null, reviewCount: 1 },
        reviews: [
          { label: 'The Quietus (via review-gatherer)', outlet: 'The Quietus', via: 'review-gatherer', score: null, scoreRaw: 'unscored', url: 'https://thequietus.com/1', publishedAt: null },
          { label: 'The Wire (via review-gatherer)', outlet: 'The Wire', via: 'review-gatherer', score: null, scoreRaw: null, url: null, publishedAt: null },
        ],
        criticRatings: [], updatedAt: null },
    ] })} />);
    const text = html.replace(/<[^>]+>/g, '');
    expect(text).toContain('The Quietusunscored');
    expect(text).toContain('The Wireno score');
    // no aggregate score: the head row has no number
    expect(text).not.toMatch(/review-gatherer[\d.]+ \/ 10/);
    expect(html).toContain('aria-label="The Quietus (via review-gatherer): the review"');
    expect(html).not.toContain('aria-label="The Wire (via review-gatherer): the review"');
  });

  it('a single source (CritiqueBrainz alone): one row, its score, the review behind it as the link', () => {
    const html = renderToStaticMarkup(<CriticScoresRow bundle={bundle({ available: true, values: [
      { source: { module: 'reviews', ref: null, label: 'CritiqueBrainz' }, aggregate: { score: 8, tier: null, reviewCount: 1 },
        reviews: [{ label: 'CritiqueBrainz', outlet: 'CritiqueBrainz', via: null, score: 8, scoreRaw: '80/100', url: 'https://critiquebrainz.org/review/1', publishedAt: null }], criticRatings: [], updatedAt: null },
    ] })} />);
    expect(html.match(/<li/g)).toHaveLength(1);
    expect(html.replace(/<[^>]+>/g, '')).toBe('Critic scoresCritiqueBrainz8.0 / 10');
    expect(html).toMatch(/<a [^>]*href="https:\/\/critiquebrainz\.org\/review\/1"[^>]*aria-label="CritiqueBrainz: the review"/);
  });

  it('shows nothing when no source is on or none has scores', () => {
    expect(renderToStaticMarkup(<CriticScoresRow bundle={bundle({ available: false, values: [] })} />)).toBe('');
    expect(renderToStaticMarkup(<CriticScoresRow bundle={bundle(undefined)} />)).toBe('');
  });
});
