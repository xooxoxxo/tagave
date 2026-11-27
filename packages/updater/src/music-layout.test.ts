import { describe, expect, it } from 'vitest';
import { musicBindKeys } from './music-layout.js';

const env = (lines: string) => `# tagave\nTAGAVE_VERSION=0.38.0\n${lines}\n`;

describe('musicBindKeys', () => {
  it('an old .env gives exactly the bind of today', () => expect(musicBindKeys(env('MUSIC_DIR=/mnt/music'))).toEqual({}));

  it('an rw install keeps a writable bind', () =>
    expect(musicBindKeys(env('MUSIC_DIR=/mnt/music\nTAGAVE_MUSIC_MODE=rw'))).toEqual({ TAGAVE_MUSIC_READ_ONLY: 'false' }));

  it('an ro install with TAGAVE_MUSIC_MODE=ro changes nothing', () =>
    expect(musicBindKeys(env('MUSIC_DIR=/mnt/music\nTAGAVE_MUSIC_MODE=ro'))).toEqual({}));

  it('a second run on an rw .env is a no-op', () =>
    expect(musicBindKeys(env('MUSIC_DIR=/mnt/music\nTAGAVE_MUSIC_MODE=rw\nTAGAVE_MUSIC_READ_ONLY=false'))).toEqual({}));

  it('a stale false on an ro install goes back to true', () =>
    expect(musicBindKeys(env('MUSIC_DIR=/mnt/music\nTAGAVE_MUSIC_MODE=ro\nTAGAVE_MUSIC_READ_ONLY=false'))).toEqual({ TAGAVE_MUSIC_READ_ONLY: 'true' }));

  it('a stale false with no mode at all goes back to true', () =>
    expect(musicBindKeys(env('MUSIC_DIR=/mnt/music\nTAGAVE_MUSIC_READ_ONLY=false'))).toEqual({ TAGAVE_MUSIC_READ_ONLY: 'true' }));

  it('an ro install that already says true changes nothing', () =>
    expect(musicBindKeys(env('MUSIC_DIR=/mnt/music\nTAGAVE_MUSIC_READ_ONLY=true'))).toEqual({}));

  it('reads quoted values as install-tagave.sh writes them', () =>
    expect(musicBindKeys(env("MUSIC_DIR='/mnt/music'\nTAGAVE_MUSIC_MODE='rw'"))).toEqual({ TAGAVE_MUSIC_READ_ONLY: 'false' }));

  it('never writes the parent layout keys', () => {
    const keys = musicBindKeys(env('MUSIC_DIR=/mnt/music\nTAGAVE_MUSIC_MODE=rw\nTAGAVE_MUSIC_BIND_SOURCE=/mnt'));
    expect(Object.keys(keys)).toEqual(['TAGAVE_MUSIC_READ_ONLY']);
  });
});
