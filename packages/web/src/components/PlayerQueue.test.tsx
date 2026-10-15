/**
 * The queue view: what it says about each track and which tracks it lets
 * the listener move or remove (only the ones still to come).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlayerQueueTrack } from '@tagave/shared';
import { PlayerQueueView } from './PlayerQueue';
import { PlayerBarView, type PlayerBarViewProps } from './PlayerBar';

const t = (n: number, extra: Partial<PlayerQueueTrack> = {}): PlayerQueueTrack => ({
  localTrackId: `t${n}`, discNo: 1, trackNo: n, title: `Song ${n}`, artist: 'Artist', album: 'Album', albumArtist: 'Artist',
  durationMs: 200_000, container: 'flac', codec: 'flac', lossless: true, mime: 'audio/flac', available: true, reason: null, ...extra,
});
const noop = () => undefined;

describe('PlayerQueueView', () => {
  const html = renderToStaticMarkup(<PlayerQueueView album="Album" tracks={[t(1), t(2), t(3), t(4, { available: false, reason: 'not_scanned' })]} index={1} onPlay={noop} onMove={noop} onRemove={noop} onClose={noop} />);
  it('says the music plays on this device and how much is left', () => {
    expect(html).toContain('Playing on this device · 2 to come');
    expect(html).toContain('Now playing');
    expect(html).toContain('aria-current="true"');
  });
  it('offers move and remove for upcoming tracks only', () => {
    expect(html).not.toContain('Remove Song 1 from the queue');
    expect(html).not.toContain('Remove Song 2 from the queue');
    expect(html).toContain('Remove Song 3 from the queue');
    expect(html).toContain('Remove Song 4 from the queue');
    // the first upcoming track cannot move above the playing one; the last cannot move down
    const tag = (label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';
    expect(tag('Move Song 3 up')).toContain('disabled');
    expect(tag('Move Song 4 down')).toContain('disabled');
    expect(tag('Move Song 4 up')).not.toContain('disabled');
  });
  it('names a track the player does not have yet', () => {
    expect(html).toContain('Not on the player yet');
  });
});

describe('the queue key', () => {
  const props: PlayerBarViewProps = {
    title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', coverUrl: null, status: 'playing', message: null,
    position: 83, duration: 296, volume: 0.8, canPrevious: true, canNext: true,
    onToggle: noop, onPrevious: noop, onNext: noop, onSeek: noop, onVolume: noop, onRetry: noop, onClose: noop,
  };
  it('appears with onQueue and shows whether the queue is open', () => {
    expect(renderToStaticMarkup(<PlayerBarView {...props} />)).not.toContain('aria-label="Queue"');
    expect(renderToStaticMarkup(<PlayerBarView {...props} onQueue={noop} queueOpen />)).toMatch(/aria-label="Queue"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Queue"/);
  });
});
