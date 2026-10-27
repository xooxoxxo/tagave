/**
 * After a move, a sidecar cover whose images row was dropped (a crash between
 * the merges and the cover re-point, or a failed re-point) is found again by
 * art.fetch in the album's new folder. Nothing in a scan queues that
 * art.fetch: the owner's Fetch art (or a bulk fetch) does.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { makeLab, type Lab } from '../testkit/moveLab.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('art.fetch after a move whose sidecar cover row was dropped (db)', () => {
  let lab: Lab;
  let cacheDir: string;
  const savedCache = process.env['CACHE_DIR'];
  let artFetchJob: typeof import('./artFetch.js').artFetchJob;

  beforeAll(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'tagave-artmove-'));
    process.env['CACHE_DIR'] = cacheDir;
    ({ artFetchJob } = await import('./artFetch.js'));
    lab = await makeLab(1);
  });

  afterAll(async () => {
    await lab?.close();
    if (savedCache === undefined) delete process.env['CACHE_DIR'];
    else process.env['CACHE_DIR'] = savedCache;
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('creates the front cover from the new folder\'s sidecar; no scan job asks for it', async () => {
    const root = lab.roots[0]!.path;
    await lab.album(0, 'Artist/Old Name', 2);
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#2e6be8' } }).jpeg().toFile(path.join(root, 'Artist/Old Name', 'folder.jpg'));
    await lab.scan(0);
    const albumId = (await lab.albumIdOf(0, 'Artist/Old Name/01 - Song 1.flac'))!;
    await artFetchJob(lab.ctx, { localAlbumId: albumId });
    const front = async () => lab.sql`select i.origin, s.rel_path from images i left join sidecar_files s on s.id = i.sidecar_file_id
                                       where i.local_album_id = ${albumId} and i.kind = 'front'`;
    expect(await front()).toEqual([{ origin: 'sidecar', rel_path: 'Artist/Old Name/folder.jpg' }]);

    await rename(path.join(root, 'Artist/Old Name'), path.join(root, 'Artist/New Name'));
    lab.sent.length = 0;
    await lab.scan(0);
    expect(await lab.albumIdOf(0, 'Artist/New Name/01 - Song 1.flac')).toBe(albumId);
    // the accepted windows: the images row is gone, the new folder's sidecar row exists
    await lab.sql`delete from images where local_album_id = ${albumId}`;
    expect(await lab.sql`select 1 from sidecar_files where scan_root_id = ${lab.roots[0]!.id} and rel_path = 'Artist/New Name/folder.jpg'`).toHaveLength(1);
    expect(lab.sent.filter((j) => j.name === 'art.fetch' || j.name === 'art.sweep')).toEqual([]);

    await artFetchJob(lab.ctx, { localAlbumId: albumId });
    expect(await front()).toEqual([{ origin: 'sidecar', rel_path: 'Artist/New Name/folder.jpg' }]);
  });
});
