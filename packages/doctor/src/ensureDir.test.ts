import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDir } from './ensureDir.js';

describe('ensureDir', () => {
  let base: string;
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'tagave-ensuredir-'));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('creates every missing level and accepts one that exists', async () => {
    const dir = join(base, 'a', 'b', 'c');
    await ensureDir(dir);
    await ensureDir(dir);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it('rejects a path under a regular file', async () => {
    const file = join(base, 'plain-file');
    await writeFile(file, 'x');
    await expect(ensureDir(join(file, 'sub'))).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  // fs.mkdir(..., { recursive: true }) never settles here on Linux.
  it.runIf(process.platform === 'linux')('rejects a path under /proc instead of hanging', async () => {
    await expect(ensureDir('/proc/tagave-cannot-write-here/sub')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 2_000);
});
