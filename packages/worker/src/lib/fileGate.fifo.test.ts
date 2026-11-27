/**
 * The spec's "fake dead share": a FIFO nobody writes to. Opening it for
 * reading blocks in the kernel the way a file call on a dead hard NFS share
 * does, and holds a libuv thread while it waits. Needs POSIX mkfifo and the
 * built helper (`pnpm --filter @tagave/worker build`).
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { FileGate } from './fileGate.js';
import { FolderOfflineError } from './folderOffline.js';

const __filename = fileURLToPath(import.meta.url);

interface DeadFolder {
  dir: string;
  fifo: string;
  cleanup: () => Promise<void>;
}

const made: DeadFolder[] = [];

async function deadFolder(): Promise<DeadFolder> {
  const dir = await mkdtemp(join(tmpdir(), 'tagave-dead-'));
  const fifo = join(dir, 'track.flac');
  execFileSync('mkfifo', [fifo]);
  const d = { dir, fifo, cleanup: () => rm(dir, { recursive: true, force: true }) };
  made.push(d);
  return d;
}

/**
 * Lets the readers blocked on the FIFO come back: opens it for writing once
 * per reader. Sync and non-blocking on purpose: an async open would queue
 * behind the very threads it means to free, and a blocking one would wait
 * for good when no reader is left (ENXIO then).
 */
async function unblock(dead: DeadFolder, readers: Promise<unknown>[] = []): Promise<void> {
  const settled = Promise.allSettled(readers);
  for (let i = 0; i < Math.max(readers.length, 1) * 10; i++) {
    try {
      closeSync(openSync(dead.fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENXIO') throw err;
    }
    if ((await Promise.race([settled.then(() => true), sleep(50).then(() => false)])) === true) return;
  }
  throw new Error('The FIFO readers did not come back');
}

afterAll(async () => {
  await Promise.all(made.map((d) => d.cleanup()));
});

/** libuv's threadpool: UV_THREADPOOL_SIZE, 4 when unset. That many hung opens take it all. */
const POOL = Number(process.env.UV_THREADPOOL_SIZE) > 0 ? Math.min(Number(process.env.UV_THREADPOOL_SIZE), 1024) : 4;

describe('a dead share', () => {
  it('today: four hung opens in this process freeze its fs', async () => {
    const dead = await deadFolder();
    const opens = Array.from({ length: POOL }, () => open(dead.fifo, 'r').catch(() => null));
    const r = await Promise.race([readFile(__filename).then(() => 'read'), sleep(1_000).then(() => 'stuck')]);
    expect(r).toBe('stuck');
    await unblock(dead, opens); // opens the FIFO for writing once per reader, so the threads come back
    for (const h of await Promise.all(opens)) await (h as FileHandle | null)?.close();
    await dead.cleanup();
  });

  it('through the gate: the same four opens leave this process free and the job offline', async () => {
    const dead = await deadFolder();
    // readSmall is a long op: its idle deadline is the one that gives up here.
    const g = new FileGate({ limits: { waitMs: 300, idleMs: 300, helpers: 2, stuckMax: 8 } });
    const calls = Array.from({ length: 4 }, () => g.run('r', { op: 'readSmall', path: dead.fifo }).catch((e) => e));
    expect(await Promise.race([readFile(__filename).then(() => 'read'), sleep(1_000).then(() => 'stuck')])).toBe('read');
    for (const e of await Promise.all(calls)) expect(e).toBeInstanceOf(FolderOfflineError);
    expect(g.stuckCount('r')).toBe(4);
    await unblock(dead);
    await g.close();
    await dead.cleanup();
  });
});
