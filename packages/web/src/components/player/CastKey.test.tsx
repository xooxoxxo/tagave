import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CastKeyView, type CastKeyViewProps } from './CastKey';
import { MiniPlayer } from './NowPlaying';
import { PlayerBarView } from '../PlayerBar';

const base: CastKeyViewProps = { kind: 'cast', available: true, state: 'off', device: null, reach: 'ok', host: 'music.example.test', onChoose: () => undefined };
const html = (p: Partial<CastKeyViewProps>) => renderToStaticMarkup(<CastKeyView {...base} {...p} />);

describe('the cast key', () => {
  it('is there only while a device is, or while casting', () => {
    expect(html({ available: false })).toBe('');
    expect(html({ kind: null })).toBe('');
    expect(html({ available: false, state: 'on', device: 'Kitchen' })).toContain('Casting to Kitchen');
  });

  it('is an embossed key, AirPlay’s on Safari, the accent while casting', () => {
    const off = html({});
    expect(off).toContain('aria-label="Cast"');
    expect(off).not.toContain('data-casting');
    expect(html({ kind: 'airplay' })).toContain('aria-label="AirPlay"');
    const on = html({ kind: 'airplay', state: 'on' });
    expect(on).toContain('data-casting=""');
    expect(on).toContain('aria-label="AirPlay"');
  });

  it('opens a menu instead of the picker when PUBLIC_URL cannot be reached, or while the SDK casts', () => {
    expect(html({ reach: 'loopback', host: 'localhost:3000' })).toContain('aria-haspopup="menu"');
    expect(html({ reach: 'http', kind: 'airplay' })).not.toContain('aria-haspopup');
    expect(html({ state: 'on', device: 'Living Room' })).toContain('aria-label="Casting to Living Room"');
    expect(html({ state: 'on', device: 'Living Room' })).toContain('aria-haspopup="menu"');
  });
});

describe('casting in the bars', () => {
  const track = {
    localTrackId: 't', discNo: 1, trackNo: 1, title: 'Song', artist: 'Artist', album: 'Album', albumArtist: 'Artist', durationMs: 1000,
    container: 'flac', codec: 'flac', lossless: true, mime: 'audio/flac', available: true, reason: null, albumId: 'a', coverUrl: null, artists: [], year: null,
    origin: 'context' as const, uid: 'u',
  };
  it('the mini bar puts "Casting to …" in the artist’s line', () => {
    const mini = (castLine: string | null) => renderToStaticMarkup(
      <MiniPlayer track={track} status="playing" position={0} duration={1} canNext onOpen={() => undefined} onToggle={() => undefined} onNext={() => undefined} onRetry={() => undefined} castLine={castLine} />,
    );
    expect(mini('Casting to Kitchen')).toContain('Casting to Kitchen');
    expect(mini('Casting to Kitchen')).not.toContain('>Artist<');
    expect(mini(null)).toContain('>Artist<');
  });
  it('the bar shows the key beside the queue key, and the line beside it', () => {
    const bar = renderToStaticMarkup(
      <PlayerBarView title="Song" artist="Artist" album="Album" coverUrl={null} status="playing" position={0} duration={10} volume={1} canPrevious canNext
        onToggle={() => undefined} onPrevious={() => undefined} onNext={() => undefined} onSeek={() => undefined} onVolume={() => undefined} onRetry={() => undefined} onQueue={() => undefined}
        cast={<CastKeyView {...base} state="on" device="Kitchen" />} castLine="Casting to Kitchen" />,
    );
    expect(bar.indexOf('Casting to Kitchen')).toBeLessThan(bar.indexOf('aria-label="Queue"'));
  });
});
