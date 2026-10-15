import * as nodeFs from 'node:fs/promises';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from './envFile.js';
import { mkdirKeepingOwner, writeFileKeepingOwner, type SafeWriteFs } from './safe-write.js';

let dir: string;

beforeEach(async () => {
  // realpath: macOS's tmpdir is behind a symlink, and writes resolve links.
  dir = await realpath(await mkdtemp(join(tmpdir(), 'tagave-safe-write-')));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** writeFile, then chmod: the mode option of writeFile is cut by the umask. */
const put = async (p: string, text: string, mode = 0o644) => {
  await writeFile(p, text);
  await chmod(p, mode);
};
const modeOf = async (p: string) => (await stat(p)).mode & 0o777;

/**
 * The real filesystem, except that stat reports another owner for the paths
 * in `owners` (as root sees a file of the install's user) and chown is only
 * recorded: a test that does not run as root cannot give a file away.
 */
function recordingFs(owners: Record<string, { uid: number; gid: number }>) {
  const chowns: Array<{ path: string; uid: number; gid: number }> = [];
  const fs: SafeWriteFs = {
    ...nodeFs,
    stat: async (p) => {
      const s = await nodeFs.stat(p);
      const o = owners[p];
      return o ? { uid: o.uid, gid: o.gid, mode: s.mode } : s;
    },
    chown: async (path, uid, gid) => { chowns.push({ path, uid, gid }); },
  };
  return { fs, chowns };
}

describe('writeFileKeepingOwner', () => {
  it('keeps the mode of the file it replaces', async () => {
    const p = join(dir, 'compose.yml');
    await put(p, 'old', 0o640);
    await writeFileKeepingOwner(p, 'new');
    expect(await readFile(p, 'utf8')).toBe('new');
    expect(await modeOf(p)).toBe(0o640);
  });

  it("chowns the new file to the original's uid and gid before renaming it into place", async () => {
    const p = join(dir, '.env');
    await put(p, 'A=1\n', 0o600);
    const { fs, chowns } = recordingFs({ [p]: { uid: 1000, gid: 1001 } });
    let renamedAfterChown = false;
    const watched: SafeWriteFs = { ...fs, rename: async (a, b) => { renamedAfterChown = chowns.length === 1; await nodeFs.rename(a, b); } };
    await writeFileKeepingOwner(p, 'A=2\n', { fs: watched });
    expect(chowns).toHaveLength(1);
    expect(chowns[0]).toMatchObject({ uid: 1000, gid: 1001 });
    expect(chowns[0]!.path).not.toBe(p); // the temp file, so the swap is atomic
    expect(renamedAfterChown).toBe(true);
    expect(await readFile(p, 'utf8')).toBe('A=2\n');
    expect(await modeOf(p)).toBe(0o600);
  });

  it("gives a new file its folder's owner and the fallback mode", async () => {
    const p = join(dir, 'state.json');
    const { fs, chowns } = recordingFs({ [dir]: { uid: 1000, gid: 100 } });
    await writeFileKeepingOwner(p, '{}', { fs });
    expect(chowns).toEqual([expect.objectContaining({ uid: 1000, gid: 100 })]);
    expect(await modeOf(p)).toBe(0o644);
    await rm(p);
    await writeFileKeepingOwner(p, '{}', { fs, fallbackMode: 0o600 });
    expect(await modeOf(p)).toBe(0o600);
  });

  it('writes through a symlink: the link stays, the file it points to is replaced with its mode', async () => {
    await mkdir(join(dir, 'real'));
    const real = join(dir, 'real', 'env');
    await put(real, 'A=1\n', 0o640);
    const link = join(dir, '.env');
    await symlink(real, link);
    await writeFileKeepingOwner(link, 'A=2\n');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toBe('A=2\n');
    expect(await modeOf(real)).toBe(0o640);
    // the temp file was made next to the real file, not next to the link
    expect(await readdir(join(dir, 'real'))).toEqual(['env']);
    expect(await readdir(dir)).toEqual(['.env', 'real']);
  });

  it('a .bak of a symlinked .env is a copy next to the link, with the real file\'s mode', async () => {
    await mkdir(join(dir, 'real'));
    const real = join(dir, 'real', 'env');
    await put(real, 'A=1\n', 0o600);
    await symlink(real, join(dir, '.env'));
    await writeFileAtomic(join(dir, '.env'), 'A=2\n');
    expect((await lstat(join(dir, '.env.bak'))).isFile()).toBe(true);
    expect(await readFile(join(dir, '.env.bak'), 'utf8')).toBe('A=1\n');
    expect(await modeOf(join(dir, '.env.bak'))).toBe(0o600);
    expect(await readFile(real, 'utf8')).toBe('A=2\n');
  });

  it('fsyncs the folder after the rename; a platform that refuses is fine', async () => {
    const p = join(dir, 'compose.yml');
    await put(p, 'old');
    const opened: string[] = [];
    const order: string[] = [];
    const fs: SafeWriteFs = {
      ...nodeFs,
      rename: async (a, b) => { order.push('rename'); await nodeFs.rename(a, b); },
      open: (async (path: string, flags?: string, mode?: number) => {
        opened.push(path);
        const fh = await nodeFs.open(path, flags, mode);
        if (path === dir) {
          order.push('open dir');
          return Object.assign(Object.create(fh) as nodeFs.FileHandle, {
            sync: async () => { order.push('sync dir'); throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); },
            close: () => fh.close(),
          });
        }
        return fh;
      }) as typeof nodeFs.open,
    };
    await writeFileKeepingOwner(p, 'new', { fs });
    expect(order).toEqual(['rename', 'open dir', 'sync dir']);
    expect(await readFile(p, 'utf8')).toBe('new');
  });

  it('leaves no temp file behind when the write fails', async () => {
    const p = join(dir, 'compose.yml');
    await put(p, 'old');
    const fs: SafeWriteFs = { ...nodeFs, rename: async () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); } };
    await expect(writeFileKeepingOwner(p, 'new', { fs })).rejects.toThrow('EXDEV');
    expect(await readdir(dir)).toEqual(['compose.yml']);
    expect(await readFile(p, 'utf8')).toBe('old');
  });
});

describe('writeFileAtomic (.env, compose files, state)', () => {
  it('keeps .env 600, copies it to a .bak with the same mode, and keeps a 644 compose file 644', async () => {
    const env = join(dir, '.env');
    const compose = join(dir, 'compose.yml');
    await put(env, 'TAGAVE_VERSION=0.7.0\n', 0o600);
    await put(compose, 'services: {}\n', 0o644);
    await writeFileAtomic(env, 'TAGAVE_VERSION=0.8.0\n');
    await writeFileAtomic(compose, 'services: {a: {}}\n');
    expect(await modeOf(env)).toBe(0o600);
    expect(await modeOf(`${env}.bak`)).toBe(0o600);
    expect(await readFile(`${env}.bak`, 'utf8')).toBe('TAGAVE_VERSION=0.7.0\n');
    expect(await modeOf(compose)).toBe(0o644);
    expect(await modeOf(`${compose}.bak`)).toBe(0o644);
  });

  it('a .bak takes the mode of its original, not of an older .bak', async () => {
    const env = join(dir, '.env');
    await put(env, 'A=1\n', 0o600);
    await put(`${env}.bak`, 'A=0\n', 0o644);
    await writeFileAtomic(env, 'A=2\n');
    expect(await modeOf(`${env}.bak`)).toBe(0o600);
  });

  it('a file that did not exist is written 600', async () => {
    const p = join(dir, 'new.env');
    await writeFileAtomic(p, 'A=1\n', false);
    expect(await modeOf(p)).toBe(0o600);
  });
});

describe('mkdirKeepingOwner', () => {
  it("creates the folder with the given mode, owned like its parent; leaves an existing one alone", async () => {
    const p = join(dir, '.updater');
    const { fs, chowns } = recordingFs({ [dir]: { uid: 1000, gid: 100 } });
    await mkdirKeepingOwner(p, 0o700, { fs });
    expect(await modeOf(p)).toBe(0o700);
    expect(chowns).toEqual([{ path: p, uid: 1000, gid: 100 }]);
    await mkdirKeepingOwner(p, 0o755, { fs });
    expect(chowns).toHaveLength(1);
    expect(await modeOf(p)).toBe(0o700);
  });
});
