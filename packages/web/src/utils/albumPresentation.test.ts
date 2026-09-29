import { describe, expect, it } from 'vitest';
import { showsTrackArtists, uniqueGenres } from './albumPresentation';
describe('album genre presentation', () => {
  it('merges local and provider tags without case or whitespace duplicates', () => {
    expect(uniqueGenres(['Metal', 'math rock'], [' metal ', 'Math Rock', 'Hardcore'], undefined)).toEqual(['Metal', 'math rock', 'Hardcore']);
  });
  it('omits blank values and accepts missing sources', () => {
    expect(uniqueGenres(undefined, ['', '  '])).toEqual([]);
  });
});

describe('showsTrackArtists', () => {
  it('shows the column on a compilation whose tracks credit their own artists', () => {
    expect(showsTrackArtists([{ artist: 'Massive Attack' }, { artist: 'Nightmares on Wax' }], 'Various Artists')).toBe(true);
  });
  it('shows it when a single track credits someone else', () => {
    expect(showsTrackArtists([{ artist: 'Björk' }, { artist: 'Björk feat. Thom Yorke' }], 'Björk')).toBe(true);
  });
  it('hides it when every track carries the album artist or none at all', () => {
    expect(showsTrackArtists([{ artist: ' björk ' }, { artist: null }, { artist: '' }, {}], 'Björk')).toBe(false);
    expect(showsTrackArtists([], 'Björk')).toBe(false);
  });
});
