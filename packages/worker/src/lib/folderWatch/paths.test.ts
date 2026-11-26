/** Where the file worker finds a music root: pure string work, never the disk. */
import { describe, expect, it } from 'vitest';
import { MUSIC_MOUNT, musicName, PARENT_MOUNT, realRootPath } from './paths.js';

describe('realRootPath', () => {
  it('maps the music folder into the parent bind without touching it', () => {
    expect(realRootPath('/mnt/music', 'music')).toBe('/mnt/.host/music');
    expect(realRootPath('/mnt/music/Jazz', 'music')).toBe('/mnt/.host/music/Jazz');
    expect(realRootPath('/mnt/musicx', 'music')).toBe('/mnt/musicx');
    expect(realRootPath('/mnt/music', null)).toBe('/mnt/music');
    expect(musicName({ TAGAVE_MUSIC_NAME: '../etc' })).toBeNull();
  });
  it('leaves other roots alone', () => {
    expect(realRootPath('/srv/tagave/music', 'music')).toBe('/srv/tagave/music');
    expect(realRootPath('/mnt', 'music')).toBe('/mnt');
    expect(realRootPath('/mnt/music/', 'music')).toBe('/mnt/.host/music/');
    expect(realRootPath('/mnt/music/../x', 'music')).toBe('/mnt/.host/music/../x');
  });
  it('uses the constants', () => {
    expect(MUSIC_MOUNT).toBe('/mnt/music');
    expect(PARENT_MOUNT).toBe('/mnt/.host');
    expect(realRootPath(`${MUSIC_MOUNT}/A B`, 'My Music')).toBe(`${PARENT_MOUNT}/My Music/A B`);
  });
});

describe('musicName', () => {
  it.each([
    ['music', 'music'],
    ['My Music-2.0_x', 'My Music-2.0_x'],
    ['a'.repeat(255), 'a'.repeat(255)],
    ['a'.repeat(256), null],
    ['.', null],
    ['..', null],
    ['', null],
    ['a/b', null],
    ['music\n', null],
    [undefined, null],
  ])('%#', (value, want) => expect(musicName(value === undefined ? {} : { TAGAVE_MUSIC_NAME: value })).toBe(want));
});
