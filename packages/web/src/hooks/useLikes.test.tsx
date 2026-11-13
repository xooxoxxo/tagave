/**
 * Likes in the app: the toggle's optimistic keys, Like's place in every
 * song's menu, the Liked filter in the albums and artists URLs, the heart's
 * names.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => undefined, Link: () => null }));

const { toggledKeys } = await import('./useLikes');
const { trackMenuKeys } = await import('../components/player/TrackActions');
const { chipText, parseAlbumsSearch, activeFilterCount } = await import('../pages/albumsSearch');
const { parseArtistsSearch } = await import('../pages/artistsView');
const { LikeKeyView } = await import('../components/LikeKey');

describe('the like toggle', () => {
  const keys = { songs: ['a'], albums: [], artists: ['x'] };
  it('puts an id in or takes it out at once, once', () => {
    expect(toggledKeys(keys, 'song', 'b', true).songs).toEqual(['a', 'b']);
    expect(toggledKeys(keys, 'song', 'a', true).songs).toEqual(['a']);
    expect(toggledKeys(keys, 'artist', 'x', false).artists).toEqual([]);
    expect(toggledKeys(keys, 'album', 'm', true)).toEqual({ songs: ['a'], albums: ['m'], artists: ['x'] });
  });
});

describe('Like in every song’s menu', () => {
  it('comes after Add to playlist, before Go to album', () => {
    const all = { queue: true, playlists: true, album: true, artist: true, like: true };
    expect(trackMenuKeys(all).map((k) => k.key)).toEqual(['next', 'queue', 'playlist', 'like', 'album', 'artist']);
    // no player, no playlists: Like alone leads
    expect(trackMenuKeys({ ...all, queue: false, playlists: false })).toEqual([
      { key: 'like', separated: false }, { key: 'album', separated: true }, { key: 'artist', separated: false },
    ]);
  });
});

describe('the Liked filter in the address', () => {
  it('albums: ?liked=yes is a filter with its chip', () => {
    expect(parseAlbumsSearch({ liked: 'yes', genre: 'Jazz' })).toEqual({ liked: 'yes', genre: ['Jazz'] });
    expect(activeFilterCount(parseAlbumsSearch({ liked: 'yes' }))).toBe(1);
    expect(chipText('liked', 'yes')).toBe('Liked');
  });
  it('artists: ?liked=yes, anything else is no filter', () => {
    expect(parseArtistsSearch({ liked: 'yes', sort: 'albums' })).toEqual({ liked: 'yes', sort: 'albums' });
    expect(parseArtistsSearch({ liked: '1' })).toEqual({});
  });
});

describe('the heart', () => {
  it('is named Like or Unlike, filled when liked, with no circle', () => {
    const off = renderToStaticMarkup(<LikeKeyView liked={false} onToggle={() => undefined} />);
    const on = renderToStaticMarkup(<LikeKeyView liked onToggle={() => undefined} />);
    expect(off).toContain('aria-label="Like"');
    expect(on).toContain('aria-label="Unlike"');
    expect(off).toContain('fill="none"');
    expect(on).toContain('fill="currentColor"');
    expect(on).toContain('data-liked');
    expect(on).not.toMatch(/<circle/);
  });
});
