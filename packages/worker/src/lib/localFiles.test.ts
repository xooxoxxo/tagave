import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workerCacheRoot, writeCacheFile } from './localFiles.js';

describe('writeCacheFile: the worker cache folder only', () => {
  let dir = '';
  let env: NodeJS.ProcessEnv;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tagave-cache-'));
    env = { CACHE_DIR: path.join(dir, 'cache') };
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('writes a file under the cache folder, its folder made first', async () => {
    const file = path.join(workerCacheRoot(env), 'covers', 'lib', 'album.jpg');
    await writeCacheFile(file, new Uint8Array([1, 2, 3]), env);
    expect([...(await readFile(file))]).toEqual([1, 2, 3]);
  });

  it.each([
    ['a music path', '/mnt/music/Robin/Album/cover.jpg'],
    ['a sibling folder', 'cache-other/cover.jpg'],
    ['a way out with ..', 'cache/../outside.jpg'],
    ['the cache folder itself', 'cache'],
  ])('refuses %s', async (_what, p) => {
    const file = path.isAbsolute(p) ? p : path.join(dir, p);
    await expect(writeCacheFile(file, new Uint8Array([1]), env)).rejects.toThrow('Not in the worker cache folder');
  });
});
