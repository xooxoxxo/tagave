/**
 * What is playing links to its artist and album pages: in the player bar
 * and in the queue (each credited artist its own link; a name tagave cannot
 * tie to an artist stays plain text).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlayerQueueTrack } from '@tagave/shared';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: unknown; className?: string }) => {
    let href = to;
    for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v);
    return <a href={href} className={className}>{children as never}</a>;
  },
}));

import { linkedArtists } from './NowPlayingLinks';
import { PlayerBarView, type PlayerBarViewProps } from './PlayerBar';
import { PlayerQueueView } from './PlayerQueue';

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

describe('the queue', () => {
  const t = (n: number, artist: string): PlayerQueueTrack => ({
    localTrackId: `t${n}`, discNo: 1, trackNo: n, title: `Song ${n}`, artist, album: 'Chet', albumArtist: 'Chet Baker',
    durationMs: 200_000, container: 'flac', codec: 'flac', lossless: true, mime: 'audio/flac', available: true, reason: null,
  });
  const html = renderToStaticMarkup(
    <PlayerQueueView album="Chet" albumId="al1" albumArtist="Chet Baker" artists={[duo[0]!]} tracks={[t(1, 'Chet Baker'), t(2, 'Chet Baker'), t(3, 'A Guest')]} index={0} onPlay={noop} onMove={noop} onRemove={noop} onClose={noop} />,
  );
  it('links the album and the artists of the tracks to come, outside the row buttons', () => {
    expect(html).toContain('href="/albums/al1"');
    expect(html.match(/href="\/artists\/a1"/g)).toHaveLength(1);
    expect(html).toContain('A Guest');
    // a link is never inside a button
    for (const button of html.match(/<button[\s\S]*?<\/button>/g) ?? []) expect(button).not.toContain('<a ');
  });
  it('still says which track plays now', () => {
    expect(html).toContain('Now playing');
  });
});
