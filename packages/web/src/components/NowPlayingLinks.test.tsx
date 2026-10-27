/**
 * What is playing links to its artist and album pages: in the player bar
 * and in Now Playing (each credited artist its own link; a name tagave cannot
 * tie to an artist stays plain text).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: unknown; className?: string }) => {
    let href = to;
    for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v);
    return <a href={href} className={className}>{children as never}</a>;
  },
}));

import { linkedArtists } from './NowPlayingLinks';
import { PlayerBarView, type PlayerBarViewProps } from './PlayerBar';
import { NowPlayingView } from './player/NowPlaying';
import type { QueueEntry } from '../player/engine';

const noop = () => undefined;
const duo = [{ id: 'a1', name: 'Chet Baker' }, { id: 'a2', name: 'Bill Evans' }];

describe('linkedArtists', () => {
  it('stands the album artist for its credited artists', () => {
    expect(linkedArtists('Chet Baker & Bill Evans', 'Chet Baker & Bill Evans', duo)).toEqual(duo);
    expect(linkedArtists('chet baker, bill evans', 'Various', duo)).toEqual(duo);
  });
  it('finds the one credited artist a track names', () => {
    expect(linkedArtists('Bill Evans', 'Chet Baker & Bill Evans', duo)).toEqual([duo[1]]);
  });
  it('leaves a name it cannot tie to an artist as text', () => {
    expect(linkedArtists('Someone Else', 'Chet Baker & Bill Evans', duo)).toBeNull();
    expect(linkedArtists('Chet Baker', 'Chet Baker', [])).toBeNull();
    expect(linkedArtists('Chet Baker', 'Chet Baker', undefined)).toBeNull();
  });
});

describe('the player bar', () => {
  const props: PlayerBarViewProps = {
    title: 'Alone Together', artist: 'Chet Baker & Bill Evans', album: 'Chet', coverUrl: null, status: 'playing', message: null,
    position: 10, duration: 200, volume: 1, canPrevious: true, canNext: true,
    onToggle: noop, onPrevious: noop, onNext: noop, onSeek: noop, onVolume: noop, onRetry: noop, onClose: noop,
  };
  it('links each artist and the album', () => {
    const html = renderToStaticMarkup(<PlayerBarView {...props} artists={duo} albumId="al1" />);
    expect(html).toContain('href="/artists/a1"');
    expect(html).toContain('href="/artists/a2"');
    expect(html).toContain('href="/albums/al1"');
    expect(html).toMatch(/>Chet Baker<\/a>, <a[^>]*>Bill Evans<\/a> · <a[^>]*>Chet<\/a>/);
  });
  it('keeps plain text without ids', () => {
    const html = renderToStaticMarkup(<PlayerBarView {...props} />);
    expect(html).not.toContain('<a ');
    expect(html).toContain('Chet Baker &amp; Bill Evans · Chet');
  });
});

describe('Now Playing and its queue', () => {
  const t = (n: number, artist: string, origin: 'queued' | 'context' = 'context'): QueueEntry => ({
    localTrackId: `t${n}`, discNo: 1, trackNo: n, title: `Song ${n}`, artist, album: 'Chet', albumArtist: 'Chet Baker', albumId: 'al1', coverUrl: null,
    artists: [duo[0]!], year: 1959, durationMs: 200_000, container: 'flac', codec: 'flac', lossless: true, mime: 'audio/flac', available: true, reason: null,
    origin, uid: `u${n}`,
  });
  const tracks = [t(1, 'Chet Baker'), t(2, 'A Guest', 'queued'), t(3, 'Chet Baker')];
  const html = renderToStaticMarkup(
    <NowPlayingView track={tracks[0]!} tracks={tracks} index={0} context={{ kind: 'album', id: 'al1', name: 'Chet' }} history={[]}
      onPlay={noop} onMove={noop} onRemove={noop} onClear={noop} onClose={noop} />,
  );
  it('links the playing track’s artist and album, never inside a button', () => {
    expect(html).toContain('href="/albums/al1"');
    expect(html).toContain('href="/artists/a1"');
    for (const button of html.match(/<button[\s\S]*?<\/button>/g) ?? []) expect(button).not.toContain('<a ');
  });
  it('groups what comes next: added by hand first, then the rest of the album', () => {
    expect(html).toContain('Now playing');
    expect(html).toContain('Next in queue');
    expect(html).toContain('Next from Chet');
    expect(html.indexOf('Song 2')).toBeLessThan(html.indexOf('Song 3'));
  });
});
