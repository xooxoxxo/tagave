import { describe, expect, it } from 'vitest';
import { orderScoreKeys, scoreLabel } from './matchScores';

describe('scoreLabel', () => {
  it('uses plain names, never the internal keys', () => {
    expect(['album', 'artist', 'trackTitle', 'tracks', 'unmatchedTracks', 'year'].map(scoreLabel))
      .toEqual(['Album', 'Artist', 'Track titles', 'Track count', 'Unmatched tracks', 'Year']);
  });

  it('splits an unknown camelCase key into words', () => {
    expect(scoreLabel('someNewThing')).toBe('Some new thing');
  });
});

describe('orderScoreKeys', () => {
  it('keeps one fixed reading order whatever order the keys arrive in', () => {
    const a = orderScoreKeys(['year', 'tracks', 'album', 'unmatchedTracks', 'artist', 'trackTitle']);
    const b = orderScoreKeys(['trackTitle', 'artist', 'year', 'album', 'tracks', 'unmatchedTracks']);
    expect(a).toEqual(['album', 'artist', 'trackTitle', 'tracks', 'unmatchedTracks', 'year']);
    expect(b).toEqual(a);
  });

  it('puts unknown keys last, alphabetically, and drops duplicates', () => {
    expect(orderScoreKeys(['zeta', 'year', 'alpha', 'album', 'year'])).toEqual(['album', 'year', 'alpha', 'zeta']);
  });
});
