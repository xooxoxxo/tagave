/**
 * The real file helper (dist/lib/fileHelper.js), forked by the gate, on real
 * temp files. Build first: `pnpm --filter @tagave/worker build`.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashAudioStream } from '@tagave/core';
import { FileGate } from './fileGate.js';
import { FolderOfflineError } from './folderOffline.js';
import { resolvePythonInterpreter } from './tagWriter.js';
import { flacBytes } from '../testkit/flac.js';

type Page = { entries: Array<{ name: string; type: 'file' | 'dir' | 'link' | 'other' }>; cursor: string | null };

/** A tagged FLAC with some stand-in frame bytes after the metadata, so its audio hash covers something. */
const FLAC_FIXTURE = Buffer.concat([
  flacBytes({ title: 'Song', artist: 'Robin', album: 'Album', track: 1, seconds: 10 }),
  Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256)),
]);

type Tree = { [name: string]: string | Buffer | Tree };

const dirs: string[] = [];
const savedPython = process.env.TAGAVE_TAGWRITER_PYTHON;
const gates: FileGate[] = [];

/** A temp folder holding the tree; removed after each test. */
async function tree(spec: Tree, root?: string): Promise<string> {
  const dir = root ?? (await mkdtemp(join(tmpdir(), 'tagave-helper-')));
  if (!root) dirs.push(dir);
  for (const [name, v] of Object.entries(spec)) {
    const p = join(dir, name);
    if (typeof v === 'string' || Buffer.isBuffer(v)) await writeFile(p, v);
    else {
      await mkdir(p);
      await tree(v, p);
    }
  }
  return dir;
}

const gate = (limits: Partial<{ waitMs: number; idleMs: number; helpers: number; stuckMax: number }> = {}) => {
  const g = new FileGate({ limits: { helpers: 1, ...limits } });
  gates.push(g);
  return g;
};

/** This process's real helpers still running (children only). */
function helpers(): string[] {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid), '-f', 'fileHelper.js'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function mutagenAvailable(): boolean {
  try {
    execFileSync(resolvePythonInterpreter(), ['-c', 'import mutagen'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.close()));
  expect(helpers()).toEqual([]);
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  delete process.env.TAGAVE_HELPER_TEST_STOP_AFTER;
  delete process.env.TAGAVE_HELPER_TEST_SIDECAR_MS;
  if (savedPython === undefined) delete process.env.TAGAVE_TAGWRITER_PYTHON;
  else process.env.TAGAVE_TAGWRITER_PYTHON = savedPython;
});

describe('fileHelper', () => {
  it('stats, lists in pages, reads small files and refuses large ones', async () => {
    const dir = await tree({ 'a.flac': FLAC_FIXTURE, 'b.txt': 'x', sub: {} });
    const g = gate();
    expect(await g.run('r', { op: 'stat', path: join(dir, 'a.flac') })).toMatchObject({ isFile: true });
    const p1 = await g.run<Page>('r', { op: 'readdirPage', path: dir, limit: 2 });
    const p2 = await g.run<Page>('r', { op: 'readdirPage', path: dir, cursor: p1.cursor, limit: 2 });
    expect([...p1.entries, ...p2.entries].map((e) => e.name).sort()).toEqual(['a.flac', 'b.txt', 'sub']);
    await expect(g.run('r', { op: 'readSmall', path: join(dir, 'a.flac'), maxBytes: 10 })).rejects.toMatchObject({ code: 'E2BIG' });
  });

  it('stat answers the fields the worker uses, as bigints when asked', async () => {
    const dir = await tree({ 'b.txt': 'xyz', sub: {} });
    const g = gate();
    const s = await g.run<Record<string, unknown>>('r', { op: 'stat', path: join(dir, 'b.txt') });
    expect(s).toMatchObject({ size: 3, isFile: true, isDirectory: false });
    expect(Object.keys(s).sort()).toEqual(['dev', 'ino', 'isDirectory', 'isFile', 'mode', 'mtimeMs', 'size']);
    const b = await g.run<Record<string, unknown>>('r', { op: 'stat', path: join(dir, 'sub'), bigint: true });
    expect(b).toMatchObject({ isFile: false, isDirectory: true });
    expect(typeof b.ino).toBe('bigint');
    expect(typeof b.size).toBe('bigint');
  });

  it('pages carry types, end with a null cursor, and resume past a name that went away', async () => {
    const dir = await tree({ a: 'x', b: 'x', c: 'x', d: {}, e: 'x' });
    await symlink(join(dir, 'a'), join(dir, 'f'));
    const g = gate();
    const all = await g.run<Page>('r', { op: 'readdirPage', path: dir });
    expect(all.cursor).toBeNull();
    expect(Object.fromEntries(all.entries.map((e) => [e.name, e.type]))).toEqual({ a: 'file', b: 'file', c: 'file', d: 'dir', e: 'file', f: 'link' });
    const p1 = await g.run<Page>('r', { op: 'readdirPage', path: dir, limit: 2 });
    expect(p1.cursor).not.toBeNull();
    await rm(join(dir, p1.cursor!));
    const rest: string[] = [];
    let cursor = p1.cursor;
    while (cursor !== null) {
      const p = await g.run<Page>('r', { op: 'readdirPage', path: dir, cursor, limit: 2 });
      rest.push(...p.entries.map((e) => e.name));
      cursor = p.cursor;
    }
    expect([...p1.entries.map((e) => e.name), ...rest].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('runs the small metadata ops and passes the real error code through', async () => {
    const dir = await tree({ 'b.txt': 'hello' });
    const g = gate();
    expect(Buffer.from(await g.run<Uint8Array>('r', { op: 'readSmall', path: join(dir, 'b.txt') })).toString()).toBe('hello');
    await g.run('r', { op: 'mkdir', path: join(dir, 'n', 'm'), recursive: true });
    await g.run('r', { op: 'rename', from: join(dir, 'b.txt'), to: join(dir, 'n', 'c.txt') });
    await g.run('r', { op: 'access', path: join(dir, 'n', 'c.txt') });
    expect(await g.run('r', { op: 'realpath', path: join(dir, 'n', 'm', '..', 'c.txt') })).toMatch(/n\/c\.txt$/);
    expect(await g.run('r', { op: 'statfs', path: dir })).toMatchObject({ bsize: expect.any(Number), bavail: expect.any(Number) });
    await g.run('r', { op: 'unlink', path: join(dir, 'n', 'c.txt') });
    await g.run('r', { op: 'rmdir', path: join(dir, 'n', 'm') });
    expect(await readdir(join(dir, 'n'))).toEqual([]);
    await expect(g.run('r', { op: 'stat', path: join(dir, 'gone') })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(g.run('r', { op: 'lstat', path: join(dir, 'gone') })).rejects.not.toBeInstanceOf(FolderOfflineError);
  });

  it('answers a bad op or an unknown handler with an error, and keeps working', async () => {
    const dir = await tree({ 'a.flac': FLAC_FIXTURE });
    const g = gate();
    await expect(g.run('r', { op: 'nope' } as never)).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(g.run('r', { op: 'parse', handlerId: 'mobi', path: join(dir, 'a.flac') })).rejects.toMatchObject({ code: 'ENOHANDLER' });
    await expect(g.run('r', { op: 'stat' } as never)).rejects.toMatchObject({ code: 'EINVAL' });
    expect(await g.run('r', { op: 'stat', path: join(dir, 'a.flac') })).toMatchObject({ isFile: true });
  });

  it('parses through the file handler, as scan.parse does today', async () => {
    const dir = await tree({ 'a.flac': FLAC_FIXTURE });
    const g = gate();
    const parsed = await g.run<{ columns: Record<string, unknown>; metadata: unknown }>('r', { op: 'parse', handlerId: 'audio', path: join(dir, 'a.flac') });
    expect(parsed.columns).toMatchObject({ codec: 'FLAC', durationMs: 10_000, sampleRate: 44_100 });
    expect(JSON.stringify(parsed.metadata)).toContain('Robin');
  });

  it('hashes, reads audio metadata and answers a handler without a cover', async () => {
    const dir = await tree({ 'a.flac': FLAC_FIXTURE });
    const g = gate();
    const abs = join(dir, 'a.flac');
    expect(await g.run('r', { op: 'contentHash', handlerId: 'audio', path: abs })).toBe(await hashAudioStream(abs, 'flac'));
    const meta = await g.run<{ common: { artist?: string } }>('r', { op: 'parseAudio', path: abs, options: { duration: true, skipCovers: true } });
    expect(meta.common.artist).toBe('Robin');
    await expect(g.run('r', { op: 'cover', handlerId: 'audio', path: abs, metadata: {} })).rejects.toMatchObject({ code: 'ENOTSUP' });
  });

  it('a tag write cut off mid-file leaves the original', async () => {
    const dir = await tree({ 'a.flac': FLAC_FIXTURE });
    const abs = join(dir, 'a.flac');
    const hashBefore = await hashAudioStream(abs, 'flac');
    // The helper reads the hook at fork, so it is set before the gate forks one.
    process.env.TAGAVE_HELPER_TEST_STOP_AFTER = 'copy';
    const g = gate({ idleMs: 1_000 });
    await expect(g.run('r', { op: 'writeTagged', path: abs, handlerId: 'audio', values: { title: 'Changed' } })).rejects.toBeInstanceOf(FolderOfflineError);
    expect(g.stuckCount('r')).toBe(1);
    expect(Buffer.compare(await readFile(abs), FLAC_FIXTURE)).toBe(0);
    expect(await hashAudioStream(abs, 'flac')).toBe(hashBefore);
    // What is left is the temp copy, under its own dot name, never at the original's path.
    for (const name of await readdir(dir)) if (name !== 'a.flac') expect(name).toMatch(/^\.tagave-tmp-[0-9a-f-]+\.flac$/);
  });

  it('a sidecar that never answers is the share hanging: the write gives up, counts stuck and leaves the original', async () => {
    const dir = await tree({ 'a.flac': FLAC_FIXTURE });
    const abs = join(dir, 'a.flac');
    const fake = join(dir, '.fake-python');
    await writeFile(fake, '#!/bin/sh\necho "tagwriter sidecar started" >&2\nwhile read line; do :; done\n', { mode: 0o755 });
    // The helper reads these at fork.
    process.env.TAGAVE_TAGWRITER_PYTHON = fake;
    process.env.TAGAVE_HELPER_TEST_SIDECAR_MS = '300';
    const g = gate({ idleMs: 10_000 });
    const err = await g.run('r', { op: 'writeTagged', path: abs, handlerId: 'audio', values: { title: 'Changed' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FolderOfflineError);
    expect((err as FolderOfflineError).reason).toBe('timeout');
    expect(g.stuckCount('r')).toBe(1);
    expect(Buffer.compare(await readFile(abs), FLAC_FIXTURE)).toBe(0);
    expect((await readdir(dir)).sort()).toEqual(['.fake-python', 'a.flac']);
    // The helper itself is fine and takes the next op.
    expect(await g.run('r', { op: 'stat', path: abs })).toMatchObject({ isFile: true });
  }, 20_000);

  it.skipIf(!mutagenAvailable())('writes tags through the safe steps and keeps the audio', async () => {
    const dir = await tree({ 'a.flac': FLAC_FIXTURE });
    const abs = join(dir, 'a.flac');
    const hashBefore = await hashAudioStream(abs, 'flac');
    const g = gate();
    expect(await g.run('r', { op: 'writeTagged', path: abs, handlerId: 'audio', values: { title: 'Changed' } })).toEqual({});
    expect(await hashAudioStream(abs, 'flac')).toBe(hashBefore);
    const parsed = await g.run<{ metadata: unknown }>('r', { op: 'parse', handlerId: 'audio', path: abs });
    expect(JSON.stringify(parsed.metadata)).toContain('Changed');
    expect(await readdir(dir)).toEqual(['a.flac']);
  }, 20_000);
});
