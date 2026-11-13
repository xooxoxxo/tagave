import { describe, expect, it } from 'vitest';
import { deleteCommand, deleteModeOf, groupDeletions, shellQuote } from './deletions.js';

describe('the Marked list delete command', () => {
  it('quotes every path for a POSIX shell', () => {
    expect(shellQuote("Guns N' Roses/01 It's So Easy.flac")).toBe(`'Guns N'\\'' Roses/01 It'\\''s So Easy.flac'`);
    expect(shellQuote('$(rm -rf ~) `x` "y".mp3')).toBe(`'$(rm -rf ~) \`x\` "y".mp3'`);
  });

  it('one line per music folder: cd into it as the host sees it, then rm -f -- the exact files', () => {
    expect(deleteCommand([
      { root: '/srv/music', relPath: 'B/02.flac' },
      { root: '/srv/music', relPath: 'A/01.flac' },
      { root: '/Volumes/Other Disk', relPath: 'C/03.mp3' },
    ])).toBe([
      `cd '/srv/music' && rm -f -- 'A/01.flac' 'B/02.flac'`,
      `cd '/Volumes/Other Disk' && rm -f -- 'C/03.mp3'`,
    ].join('\n'));
  });

  it('nothing marked: no command', () => {
    expect(deleteCommand([])).toBeNull();
  });
});

describe('deleteModeOf', () => {
  it('Mark until the owner picks Trash', () => {
    expect(deleteModeOf({})).toBe('mark');
    expect(deleteModeOf(null)).toBe('mark');
    expect(deleteModeOf({ deleteMode: 'nonsense' })).toBe('mark');
    expect(deleteModeOf({ deleteMode: 'trash' })).toBe('trash');
  });
});

describe('groupDeletions', () => {
  const at = (s: string) => new Date(`2026-11-02T${s}:00Z`);
  const base = { kind: 'mark' as const, state: 'marked' as const, error: null, root: '/m', albumArtist: 'Artist', trackArtist: 'Artist' };
  it('one row per album, a whole album says so; a single song names itself', () => {
    const groups = groupDeletions([
      { ...base, fileId: 'f1', relPath: 'A/01.flac', createdAt: at('10:00'), albumId: 'a', albumTitle: 'Album A', trackTitle: 'One', albumFiles: 2 },
      { ...base, fileId: 'f2', relPath: 'A/02.flac', createdAt: at('10:01'), albumId: 'a', albumTitle: 'Album A', trackTitle: 'Two', albumFiles: 2 },
      { ...base, fileId: 'f3', relPath: 'B/05.flac', createdAt: at('09:00'), albumId: 'b', albumTitle: 'Album B', trackTitle: 'Five', albumFiles: 9 },
    ]);
    expect(groups.map((g) => [g.key, g.fileIds, g.wholeAlbum, g.trackTitle, g.title])).toEqual([
      ['a', ['f1', 'f2'], true, null, 'Album A'],
      ['b', ['f3'], false, 'Five', 'Album B'],
    ]);
    expect(groups[0]!.createdAt).toBe('2026-11-02T10:01:00.000Z');
  });

  it('a row on its way in or out speaks for its group; the first error shows', () => {
    const [g] = groupDeletions([
      { ...base, kind: 'trash', state: 'trashed', fileId: 'f1', relPath: 'A/01.flac', createdAt: at('10:00'), albumId: 'a', albumTitle: 'A', trackTitle: 'One', albumFiles: 3 },
      { ...base, kind: 'trash', state: 'restoring', error: 'Another file is in its place', fileId: 'f2', relPath: 'A/02.flac', createdAt: at('10:00'), albumId: 'a', albumTitle: 'A', trackTitle: 'Two', albumFiles: 3 },
    ]);
    expect(g).toMatchObject({ state: 'restoring', error: 'Another file is in its place', wholeAlbum: false, trackTitle: null });
  });
});
