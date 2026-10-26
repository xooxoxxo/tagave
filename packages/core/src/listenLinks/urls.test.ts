import { describe, expect, it } from 'vitest';
import { listenSearchUrl } from '@tagave/shared';
import { classifyListenUrl, linksFromRelations } from './urls.js';
import { composeListenLinks, listenCheckDue } from './index.js';

describe('classifyListenUrl', () => {
  it.each([
    ['https://open.spotify.com/album/0tzfI6NFJqcJkWb23R3lRZ', 'spotify', 'https://open.spotify.com/album/0tzfI6NFJqcJkWb23R3lRZ'],
    ['https://open.spotify.com/intl-de/album/0tzfI6NFJqcJkWb23R3lRZ?si=abc', 'spotify', 'https://open.spotify.com/album/0tzfI6NFJqcJkWb23R3lRZ'],
    ['https://music.apple.com/gb/album/1097861387', 'apple', 'https://music.apple.com/gb/album/1097861387'],
    ['https://music.apple.com/us/album/ok-computer/1097861387?uo=4', 'apple', 'https://music.apple.com/us/album/ok-computer/1097861387'],
    ['https://www.qobuz.com/gb-en/album/ok-computer-radiohead/0634904078164', 'qobuz', 'https://play.qobuz.com/album/0634904078164'],
    ['https://open.qobuz.com/album/fxwbbmqk0rgua', 'qobuz', 'https://play.qobuz.com/album/fxwbbmqk0rgua'],
    ['https://tidal.com/album/58990510', 'tidal', 'https://tidal.com/album/58990510'],
    ['https://tidal.com/browse/album/58990510', 'tidal', 'https://tidal.com/album/58990510'],
    ['https://www.deezer.com/fr/album/14879699', 'deezer', 'https://www.deezer.com/album/14879699'],
    ['https://music.youtube.com/playlist?list=OLAK5uy_nc6afxSnmK8OFML8dF9q_0D1MBMXsGnL4', 'youtube-music', 'https://music.youtube.com/playlist?list=OLAK5uy_nc6afxSnmK8OFML8dF9q_0D1MBMXsGnL4'],
    ['https://radiohead.bandcamp.com/album/ok-computer', 'bandcamp', 'https://radiohead.bandcamp.com/album/ok-computer'],
    ['https://music.amazon.com/albums/B071SGTLJ4', 'amazon', 'https://music.amazon.com/albums/B071SGTLJ4'],
  ])('%s is an album on %s', (raw, platform, url) => {
    expect(classifyListenUrl(raw, 'album')).toEqual({ platform, url });
  });

  it.each([
    ['https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb', 'spotify', 'https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb'],
    ['https://www.qobuz.com/us-en/interpreter/radiohead/43840', 'qobuz', 'https://play.qobuz.com/artist/43840'],
    ['https://open.qobuz.com/artist/43840', 'qobuz', 'https://play.qobuz.com/artist/43840'],
    ['https://music.amazon.co.uk/artists/B000QJXOGC', 'amazon', 'https://music.amazon.co.uk/artists/B000QJXOGC'],
    ['https://music.youtube.com/channel/UCr_iyUANcn9OX_yy9piYoLw', 'youtube-music', 'https://music.youtube.com/channel/UCr_iyUANcn9OX_yy9piYoLw'],
    ['https://radiohead.bandcamp.com/', 'bandcamp', 'https://radiohead.bandcamp.com/'],
  ])('%s is an artist on %s', (raw, platform, url) => {
    expect(classifyListenUrl(raw, 'artist')).toEqual({ platform, url });
  });

  it('is no link for a track, a shop page, a video, a playlist or another kind of page', () => {
    for (const raw of [
      'https://open.spotify.com/track/2nLtzopw4rPReszdYBJU6h',
      'https://www.amazon.com/gp/product/B000002UJQ',
      'https://www.youtube.com/playlist?list=OLAK5uy_mnQGurOeWdgT_jzJ9XXxL78jgJ4lBOFQc',
      'https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
      'https://www.qobuz.com/gb-en/interpreter/radiohead/43840',
      'https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb',
      'https://daily.bandcamp.com/album/whatever',
      'not a url',
      'ftp://open.spotify.com/album/0tzfI6NFJqcJkWb23R3lRZ',
    ]) expect(classifyListenUrl(raw, 'album'), raw).toBeNull();
    expect(classifyListenUrl('https://open.spotify.com/album/0tzfI6NFJqcJkWb23R3lRZ', 'artist')).toBeNull();
    expect(classifyListenUrl('https://radiohead.bandcamp.com/album/ok-computer', 'artist')).toBeNull();
  });
});

describe('linksFromRelations', () => {
  it('keeps listening and buying relationships, the first per platform', () => {
    const links = linksFromRelations([
      { type: 'discogs', url: 'https://www.discogs.com/release/1' },
      { type: 'streaming', url: 'https://tidal.com/album/1' },
      { type: 'free streaming', url: 'https://tidal.com/album/2' },
      { type: 'purchase for mail-order', url: 'https://music.amazon.com/albums/B071SGTLJ4' },
      { type: 'purchase for download', url: 'https://www.qobuz.com/gb-en/album/x/abc' },
    ], 'album');
    expect(links).toEqual([
      { platform: 'tidal', url: 'https://tidal.com/album/1' },
      { platform: 'qobuz', url: 'https://play.qobuz.com/album/abc' },
    ]);
  });
});

describe('composeListenLinks', () => {
  it('gives each picked platform, in the person’s order: the album, else the artist, else a search', () => {
    const links = composeListenLinks({
      platforms: ['qobuz', 'spotify', 'tidal'],
      album: new Map([['spotify', 'https://open.spotify.com/album/x']]),
      artist: new Map([['qobuz', 'https://play.qobuz.com/artist/1']]),
      query: 'Radiohead OK Computer',
    });
    expect(links).toEqual([
      { platform: 'qobuz', name: 'Qobuz', url: 'https://play.qobuz.com/artist/1', kind: 'artist' },
      { platform: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/album/x', kind: 'exact' },
      { platform: 'tidal', name: 'Tidal', url: 'https://tidal.com/search?q=Radiohead%20OK%20Computer', kind: 'search' },
    ]);
  });

  it('builds every platform’s search', () => {
    expect(listenSearchUrl('qobuz', ' Björk  Post ')).toBe('https://play.qobuz.com/search?q=Bj%C3%B6rk%20Post');
    expect(listenSearchUrl('spotify', 'a & b')).toBe('https://open.spotify.com/search/a%20%26%20b');
    expect(listenSearchUrl('bandcamp', 'x')).toBe('https://bandcamp.com/search?q=x&item_type=a');
  });
});

describe('listenCheckDue', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const daysAgo = (d: number) => new Date(now - d * 86_400_000);
  it('looks again after 30 days when it found links, after 14 when it found none, and at once for a new platform', () => {
    expect(listenCheckDue(null, [], now)).toBe(true);
    expect(listenCheckDue({ checkedAt: daysAgo(29), found: 2, platforms: ['qobuz'] }, ['qobuz'], now)).toBe(false);
    expect(listenCheckDue({ checkedAt: daysAgo(31), found: 2, platforms: ['qobuz'] }, ['qobuz'], now)).toBe(true);
    expect(listenCheckDue({ checkedAt: daysAgo(13), found: 0, platforms: ['qobuz'] }, ['qobuz'], now)).toBe(false);
    expect(listenCheckDue({ checkedAt: daysAgo(15), found: 0, platforms: ['qobuz'] }, ['qobuz'], now)).toBe(true);
    expect(listenCheckDue({ checkedAt: daysAgo(1), found: 2, platforms: ['qobuz'] }, ['qobuz', 'tidal'], now)).toBe(true);
  });
});
