import { describe, expect, it } from 'vitest';
import { scanFoldersOf } from './playerScan.js';

describe('player scan folders', () => {
  const f = (libraryId: string, scanRootPath: string, relPath: string) => ({ libraryId, fileId: relPath, scanRootPath, relPath });

  it('names each written folder once, relative to the music root', () => {
    const out = scanFoldersOf([
      f('L', '/mnt/music', 'B/Album/01.flac'),
      f('L', '/mnt/music', 'B/Album/02.flac'),
      f('L', '/mnt/music/Jazz', 'A/Album/CD1/01.flac'),
    ], '/mnt/music');
    expect(out.get('L')).toEqual(['B/Album', 'Jazz/A/Album/CD1']);
  });

  it('falls back to the whole library for a file outside the music root', () => {
    const out = scanFoldersOf([f('L', '/srv/elsewhere', 'X/01.flac'), f('L', '/mnt/music', 'B/01.flac'), f('M', '/mnt/music', '01.flac')], '/mnt/music');
    expect(out.get('L')).toEqual(['']);
    expect(out.get('M')).toEqual(['']);
  });
});
