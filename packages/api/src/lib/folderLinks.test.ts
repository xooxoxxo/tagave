import { describe, expect, it } from 'vitest';
import { folderLinkBaseProblem, folderLinkFor, normalizeFolderLinkBase } from '@liner/shared';
import { albumFoldersView, folderLinksOf } from './folderLinks.js';
import { artFetchViewOf } from './artFetchState.js';

describe('folderLinkFor: the scan-root path becomes the owner’s base, the rest URL-encoded', () => {
  it('encodes every segment, so "#" and "%" stay part of the path', () => {
    expect(folderLinkFor('smb://nas/music/', '#/!!!/2013 - Thr!!!Er')).toBe('smb://nas/music/%23/!!!/2013%20-%20Thr!!!Er/');
    expect(folderLinkFor('smb://nas/music', '100%/a?b')).toBe('smb://nas/music/100%25/a%3Fb/');
  });

  it('keeps non-ASCII names readable to the OS (UTF-8 percent-encoding)', () => {
    expect(folderLinkFor('file:///Volumes/music/', 'S/Sigur Rós/Ágætis byrjun')).toBe('file:///Volumes/music/S/Sigur%20R%C3%B3s/%C3%81g%C3%A6tis%20byrjun/');
  });

  it('takes the scan-root prefix off an absolute path first', () => {
    expect(folderLinkFor('smb://nas/music/', '/music/A/Band', '/music')).toBe('smb://nas/music/A/Band/');
    expect(folderLinkFor('smb://nas/music/', '/music', '/music/')).toBe('smb://nas/music/');
    // a sibling that only shares the prefix text is not under the root
    expect(folderLinkFor('smb://nas/x/', '/musicals/A', '/music')).toBe('smb://nas/x/musicals/A/');
  });

  it('no base, or an unsafe one, gives no link', () => {
    expect(folderLinkFor(null, 'A/B')).toBeNull();
    expect(folderLinkFor('   ', 'A/B')).toBeNull();
    expect(folderLinkFor('javascript:alert(1)//', 'A')).toBeNull();
    expect(folderLinkFor('nas/music', 'A')).toBeNull();
  });

  it('validates and normalises bases', () => {
    expect(folderLinkBaseProblem('')).toBeNull();
    expect(folderLinkBaseProblem('smb://nas/music/')).toBeNull();
    expect(folderLinkBaseProblem('file:///Volumes/music')).toBeNull();
    expect(folderLinkBaseProblem('/Volumes/music')).toMatch(/scheme/);
    expect(folderLinkBaseProblem('data://x')).toMatch(/Use one of/);
    expect(normalizeFolderLinkBase(' smb://nas/music ')).toBe('smb://nas/music/');
    expect(normalizeFolderLinkBase('')).toBeNull();
  });
});

describe('album folders', () => {
  const links = { 'root-a': 'smb://nas/music/' };

  it('links each folder through the root its files are under', () => {
    expect(albumFoldersView(['A/One', 'B/Two'], [{ dir: 'A/One', scanRootId: 'root-a' }, { dir: 'B/Two', scanRootId: 'root-b' }], links)).toEqual([
      { path: 'A/One', scanRootId: 'root-a', link: 'smb://nas/music/A/One/' },
      { path: 'B/Two', scanRootId: 'root-b', link: null },
    ]);
  });

  it('a folder no file reports takes the album’s only root', () => {
    expect(albumFoldersView(['A/Moved'], [{ dir: 'A/Elsewhere', scanRootId: 'root-a' }], links)[0]?.link).toBe('smb://nas/music/A/Moved/');
  });

  it('reads the bases from library settings, JSON text or object, dropping junk', () => {
    expect(folderLinksOf({ folderLinks: { a: 'smb://x/', b: 3, c: '' } })).toEqual({ a: 'smb://x/' });
    expect(folderLinksOf(JSON.stringify({ folderLinks: { a: 'smb://x/' } }))).toEqual({ a: 'smb://x/' });
    expect(folderLinksOf(null)).toEqual({});
    expect(folderLinksOf('not json')).toEqual({});
  });
});

describe('cover-art lookup state', () => {
  it('maps pg-boss job states to what the album page says', () => {
    expect(artFetchViewOf(undefined)).toBeNull();
    expect(artFetchViewOf({ state: 'created', completed_on: null })).toEqual({ state: 'queued', finishedAt: null });
    expect(artFetchViewOf({ state: 'retry', completed_on: null })?.state).toBe('queued');
    expect(artFetchViewOf({ state: 'active', completed_on: null })?.state).toBe('running');
    expect(artFetchViewOf({ state: 'completed', completed_on: '2026-10-01T10:00:00Z' })).toEqual({ state: 'done', finishedAt: '2026-10-01T10:00:00.000Z' });
    expect(artFetchViewOf({ state: 'failed', completed_on: new Date('2026-10-01T10:00:00Z') })?.state).toBe('failed');
    expect(artFetchViewOf({ state: 'cancelled', completed_on: null })).toBeNull();
  });
});
