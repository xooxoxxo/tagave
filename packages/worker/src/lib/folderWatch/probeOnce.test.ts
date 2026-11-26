/**
 * The one-shot guarded probe: a child does the fs calls on the share, and
 * the parent can always give up on it. The FIFO tests need `mkfifo`, and the
 * forked child is built JS, so run `pnpm --filter @tagave/worker build` first.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { deadFolder } from '../../testkit/fifo.js';
import { portAnswers } from './port.js';
import { probeOnce } from './probeOnce.js';

const HANG_CHILD = fileURLToPath(new URL('../../testkit/hangChild.mjs', import.meta.url));

const made: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'offlinetest-'));
  made.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

/** Resources that keep the event loop alive, by type. */
function alive(): Record<string, number> {
  const n: Record<string, number> = {};
  for (const t of process.getActiveResourcesInfo()) n[t] = (n[t] ?? 0) + 1;
  return n;
}

describe('probeOnce', () => {
  it('answers for a readable folder', async () => {
    const dir = await tempDir(); await writeFile(join(dir, 'a.flac'), 'x');
    expect(await probeOnce(dir, ['a.flac'])).toMatchObject({ kind: 'listing', empty: false, knownFound: 1, knownAsked: 1 });
  });

  it('gives up on a child that hangs, and the parent keeps working', async () => {
    const dead = await deadFolder();
    made.push(dead.dir);
    const t = Date.now();
    // the known file is the FIFO: stat answers, the child opens it to read and hangs
    const out = await probeOnce(dead.dir, ['pipe'], { deadlineMs: 500, childPath: HANG_CHILD });
    expect(out).toEqual({ kind: 'deadline' });
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(await readFile(__filename, 'utf8')).toContain('gives up'); // the parent's fs is free
    await dead.cleanup();
  });

  it('a hung child it gave up on keeps nothing of the parent alive', async () => {
    const dead = await deadFolder();
    made.push(dead.dir);
    await settle(); // mkfifo's own child handles close a moment after it exits
    const before = alive();
    const out = await probeOnce(dead.dir, ['pipe'], { deadlineMs: 300, childPath: HANG_CHILD });
    // Read at once: a child stuck on a real dead share may never exit, so its handle must already be let go.
    const after = alive();
    expect(out).toEqual({ kind: 'deadline' });
    expect(after.ProcessWrap ?? 0).toBeLessThanOrEqual(before.ProcessWrap ?? 0);
    expect(after.Timeout ?? 0).toBeLessThanOrEqual(before.Timeout ?? 0);
    await settle();
    expect(alive().PipeWrap ?? 0).toBeLessThanOrEqual(before.PipeWrap ?? 0);
  });

  it('leaves no timer or child behind after an answer', async () => {
    const dir = await tempDir();
    await settle();
    const before = alive();
    expect(await probeOnce(dir, [], { deadlineMs: 60_000 })).toMatchObject({ kind: 'listing' });
    const after = alive();
    expect(after.Timeout ?? 0).toBeLessThanOrEqual(before.Timeout ?? 0);
    expect(after.ProcessWrap ?? 0).toBeLessThanOrEqual(before.ProcessWrap ?? 0);
  });

  it('reads an empty folder, and counts known files that are gone', async () => {
    const dir = await tempDir();
    expect(await probeOnce(dir, [])).toEqual({ kind: 'listing', empty: true, knownFound: 0, knownAsked: 0, isMountPoint: false, wasMountPoint: false });
    await writeFile(join(dir, 'b.flac'), 'x');
    expect(await probeOnce(dir, ['b.flac', 'Jazz/gone.flac', 'gone.flac'])).toEqual({
      kind: 'listing', empty: false, knownFound: 1, knownAsked: 3, isMountPoint: false, wasMountPoint: false,
    });
  });

  it('passes on the error code when the folder is not there', async () => {
    const dir = await tempDir();
    expect(await probeOnce(join(dir, 'nope'), ['a.flac'])).toEqual({ kind: 'error', code: 'ENOENT' });
  });

  it('a child that exits without answering reads as an error, never online', async () => {
    const dir = await tempDir();
    const quitter = join(dir, 'quit.mjs');
    await writeFile(quitter, 'process.exit(0);\n');
    expect(await probeOnce(dir, [], { childPath: quitter, deadlineMs: 5_000 })).toEqual({ kind: 'error', code: 'EPROBE' });
    const garbled = join(dir, 'garbled.mjs');
    await writeFile(garbled, "process.once('message', () => process.send({ ok: 'yes' }, () => process.exit(0)));\n");
    expect(await probeOnce(dir, [], { childPath: garbled, deadlineMs: 5_000 })).toEqual({ kind: 'error', code: 'EPROBE' });
  });

  it('a child path that does not load is an error, not a missing folder', async () => {
    const dir = await tempDir();
    expect(await probeOnce(dir, [], { childPath: join(dir, 'missing.js'), deadlineMs: 5_000, stderr: 'ignore' })).toEqual({ kind: 'error', code: 'EPROBE' });
  });

  it('asks about at most 5 known files', async () => {
    const dir = await tempDir();
    const names = Array.from({ length: 8 }, (_, i) => `t${i}.flac`);
    await Promise.all(names.map((n) => writeFile(join(dir, n), 'x')));
    expect(await probeOnce(dir, names)).toMatchObject({ kind: 'listing', knownFound: 5, knownAsked: 5 });
  });
});

describe('portAnswers', () => {
  it('the port check gives up after two tries', async () => {
    const tries: number[] = [];
    expect(await portAnswers('192.0.2.10', 2049, { connect: async (_h, _p, t) => { tries.push(t); return false; }, gapMs: 0 })).toBe(false);
    expect(tries).toEqual([3000, 3000]);
  });

  it('stops at the first answer, and a throwing connect counts as silent', async () => {
    let n = 0;
    const connect = async () => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return true;
    };
    expect(await portAnswers('192.0.2.10', 445, { connect, gapMs: 0, tries: 3 })).toBe(true);
    expect(n).toBe(2);
  });

  it('waits the gap between tries, not after the last', async () => {
    const t = Date.now();
    expect(await portAnswers('192.0.2.10', 2049, { connect: async () => false, gapMs: 200 })).toBe(false);
    const took = Date.now() - t;
    expect(took).toBeGreaterThanOrEqual(190);
    expect(took).toBeLessThan(380);
  });
});
