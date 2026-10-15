/**
 * The player bar's markup (what it says and offers in each state) and the
 * track list's play affordances, which exist only with a player.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlayerBarView, type PlayerBarViewProps } from './PlayerBar';
import { AlbumTracks } from '../pages/AlbumTracks';
import type { DetailTrack } from '../pages/albumDetailTypes';

const noop = () => undefined;
const props: PlayerBarViewProps = {
  title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', coverUrl: null, status: 'playing', message: null,
  position: 83, duration: 296, volume: 0.8, canPrevious: true, canNext: true,
  onToggle: noop, onPrevious: noop, onNext: noop, onSeek: noop, onVolume: noop, onRetry: noop, onClose: noop,
};

describe('PlayerBarView', () => {
  it('names the transport keys and reads the position as "1:23 of 4:56"', () => {
    const html = renderToStaticMarkup(<PlayerBarView {...props} />);
    expect(html).toContain('aria-label="Player"');
    for (const label of ['Previous track', 'Pause', 'Next track', 'Close the player', 'Seek', 'Volume']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('aria-valuetext="1:23 of 4:56"');
    expect(html).toContain('title="So What"');
  });

  it('offers Play while paused', () => {
    expect(renderToStaticMarkup(<PlayerBarView {...props} status="paused" />)).toContain('aria-label="Play"');
  });

  it('shows the error in words with Retry instead of the seek bar', () => {
    const html = renderToStaticMarkup(<PlayerBarView {...props} status="error" message="tagave did not answer. Check the connection, then try again." />);
    expect(html).toContain('tagave did not answer.');
    expect(html).toMatch(/<button[^>]*>.*Retry.*<\/button>/);
    expect(html).not.toContain('aria-label="Seek"');
  });
});

const detail = (id: string, trackNo: number): DetailTrack => ({
  id, discNo: 1, trackNo, title: `Song ${trackNo}`, durationMs: 180_000, origin: 'file', cueStartMs: null, canonicalTitle: null, canonicalDurationMs: null,
  file: { relPath: `${trackNo}.flac`, codec: 'flac', lossless: true, bitrateKbps: null, sampleRate: null, bitDepth: null, sizeBytes: null, status: 'ok' },
});

describe('AlbumTracks with and without a player', () => {
  const base = { tracks: [detail('t1', 1), detail('t2', 2)], missingTracks: [], discCount: 1, albumArtists: ['A'], artistNames: ['A'], maintenance: false };

  it('renders no play affordance without a player', () => {
    const html = renderToStaticMarkup(<AlbumTracks {...base} />);
    expect(html).not.toContain('Play from');
    expect(html).not.toContain('aria-current');
    expect(renderToStaticMarkup(<AlbumTracks {...base} player={null} />)).toBe(html);
  });

  it('offers "Play from here" on each row and marks the track playing now', () => {
    const html = renderToStaticMarkup(<AlbumTracks {...base} player={{ currentTrackId: 't2', onPlay: noop }} />);
    expect(html).toContain('aria-label="Play from Song 1"');
    expect(html).toContain('aria-label="Play from Song 2"');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain('Now playing: </span>Song 2');
  });
});
