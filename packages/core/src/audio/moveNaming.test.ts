import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMING, describeNaming, folderNaming, movedFileName, namingOf, newAlbumDir } from './moveNaming.js';

describe('move naming', () => {
  it("reads a name's pattern", () => {
    expect(namingOf('03 - Isa.flac')).toEqual({ disc: false, digits: 2, sep: ' - ', artist: false });
    expect(namingOf('3. Isa.mp3')).toEqual({ disc: false, digits: 1, sep: '. ', artist: false });
    expect(namingOf('1-03 - Isa.flac')).toMatchObject({ disc: true, digits: 2 });
    expect(namingOf('03 - Enslaved - Isa.flac', 'Enslaved')).toMatchObject({ artist: true });
    expect(namingOf('Isa.flac')).toBeNull();
  });

  it("takes a folder's pattern only when its names agree", () => {
    expect(folderNaming(['01 - Clouds.flac', '02 - To the Coast.flac'])).toEqual(DEFAULT_NAMING);
    expect(folderNaming(['01. Clouds.flac', '02 - To the Coast.flac'])).toBeNull();
    expect(folderNaming(['01. Clouds.flac'])).toMatchObject({ sep: '. ' });
    expect(folderNaming([])).toBeNull();
  });

  it('names a moved file', () => {
    expect(movedFileName(DEFAULT_NAMING, { disc: 1, position: 3, title: 'Isa', ext: '.FLAC' }, 1)).toBe('03 - Isa.flac');
    expect(movedFileName(DEFAULT_NAMING, { disc: 2, position: 1, title: 'A/B: C?', ext: '.flac' }, 2)).toBe('2-01 - A B C.flac');
    expect(movedFileName({ ...DEFAULT_NAMING, artist: true }, { disc: 1, position: 1, title: 'Isa', artist: 'Enslaved', ext: '.mp3' }, 1)).toBe('01 - Enslaved - Isa.mp3');
    expect(describeNaming(DEFAULT_NAMING)).toBe('01 - Title');
  });

  it('names a new album folder', () => {
    expect(newAlbumDir('Enslaved', 'Isa', 2004)).toBe('Enslaved/2004 - Isa');
    expect(newAlbumDir('AC/DC', 'Back in Black', null)).toBe('AC DC/Back in Black');
  });
});
