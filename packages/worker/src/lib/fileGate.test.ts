import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileGate, gateLimits } from './fileGate.js';
import { FolderOfflineError, isOfflineError } from './folderOffline.js';

const FAKE = fileURLToPath(new URL('../testkit/fakeHelper.mjs', import.meta.url));

let suspects: string[] = [];
let made: FileGate[] = [];

const gate = (limits: Partial<{ waitMs: number; idleMs: number; helpers: number; stuckMax: number }> = {}) => {
  const g = new FileGate({ helperPath: FAKE, limits: { waitMs: 300, idleMs: 1_500, helpers: 2, stuckMax: 2, ...limits }, onSuspect: (id) => suspects.push(id) });
  made.push(g);
  return g;
};

/**
 * The pids of this process's fake helpers still running (`pgrep -f
 * fakeHelper.mjs`, children of this process only, so a shell whose command
 * line names the file does not count).
 */
function fakeHelpers(): string[] {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid), '-f', 'fakeHelper.mjs'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

beforeEach(() => {
  suspects = [];
  made = [];
});

afterEach(async () => {
  await Promise.all(made.map((g) => g.close()));
  expect(fakeHelpers()).toEqual([]);
});

describe('FileGate', () => {
  it('gives up on a helper that never answers, and keeps the next call working', async () => {
    const g = gate();
    await expect(g.run('r1', { op: 'stat', path: 'hang' })).rejects.toBeInstanceOf(FolderOfflineError);
    expect(suspects).toEqual(['r1']);
    expect(g.stuckCount('r1')).toBe(1);
    expect(await g.run('r2', { op: 'stat', path: 'ok' })).toBe('ok');
  });

  it('a deadline reads as a timeout for that root', async () => {
    await expect(gate().run('r1', { op: 'stat', path: 'hang' })).rejects.toMatchObject({ scanRootId: 'r1', reason: 'timeout' });
  });

  it('never cuts off a slow hash that keeps sending progress', async () => {
    expect(await gate().run('r1', { op: 'contentHash', handlerId: 'audio', path: 'slow:3' })).toBe('slow:3');
  }, 10_000);

  it('gives up on a hash that goes quiet for the idle deadline', async () => {
    const g = gate();
    const t = Date.now();
    await expect(g.run('r1', { op: 'contentHash', handlerId: 'audio', path: 'hang' })).rejects.toBeInstanceOf(FolderOfflineError);
    expect(Date.now() - t).toBeGreaterThanOrEqual(1_400);
    expect(g.stuckCount('r1')).toBe(1);
  });

  it('stops sending a root work after too many stuck helpers, until it is clear', async () => {
    const g = gate();
    for (let i = 0; i < 2; i++) await g.run('r1', { op: 'stat', path: 'hang' }).catch(() => {});
    const t = Date.now();
    await expect(g.run('r1', { op: 'stat', path: 'ok' })).rejects.toBeInstanceOf(FolderOfflineError);
    expect(Date.now() - t).toBeLessThan(50);
    // Another root is not held back.
    expect(await g.run('r2', { op: 'stat', path: 'ok' })).toBe('ok');
    g.clear('r1');
    expect(g.stuckCount('r1')).toBe(0);
    expect(await g.run('r1', { op: 'stat', path: 'ok' })).toBe('ok');
  });

  it('an EIO answer is the folder going offline', async () => {
    const g = gate();
    await expect(g.run('r1', { op: 'stat', path: 'eio' })).rejects.toMatchObject({ scanRootId: 'r1', reason: 'io_error' });
    // The watch hears of it, but the helper answered, so it is not stuck.
    expect(suspects).toEqual(['r1']);
    expect(g.stuckCount('r1')).toBe(0);
  });

  it('a throwing onSuspect never leaves a call unsettled or stalls the queue', async () => {
    const g = new FileGate({ helperPath: FAKE, limits: { waitMs: 300, idleMs: 1_500, helpers: 1, stuckMax: 4 }, onSuspect: () => { throw new Error('watch broke'); } });
    made.push(g);
    const next = g.run('r2', { op: 'stat', path: 'b' });
    await expect(g.run('r1', { op: 'stat', path: 'hang' })).rejects.toBeInstanceOf(FolderOfflineError);
    expect(await next).toBe('b');
    await expect(g.run('r1', { op: 'stat', path: 'eio' })).rejects.toBeInstanceOf(FolderOfflineError);
    expect(() => g.markStuck('r1')).not.toThrow();
    expect(g.stuckCount('r1')).toBe(2);
  });

  it('another fs error comes back as an Error with its code', async () => {
    const err = await gate()
      .run('r1', { op: 'stat', path: 'enoent' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FolderOfflineError);
    expect(err).toMatchObject({ code: 'ENOENT' });
    expect(isOfflineError(err)).toBe(false);
  });

  it('queues work for a free helper', async () => {
    const g = gate({ helpers: 2 });
    const paths = ['a', 'b', 'c', 'd', 'e'];
    expect(await Promise.all(paths.map((p) => g.run('r1', { op: 'stat', path: p })))).toEqual(paths);
  });

  it('a call queued behind a hung one still runs on the fresh helper', async () => {
    const g = gate({ helpers: 1, stuckMax: 4 });
    const hung = g.run('r1', { op: 'stat', path: 'hang' }).catch((e: unknown) => e);
    const next = g.run('r2', { op: 'rename', from: 'moved', to: 'there' });
    expect(await hung).toBeInstanceOf(FolderOfflineError);
    expect(await next).toBe('moved');
  });

  it('markStuck counts toward the cap and tells the watch', async () => {
    const g = gate();
    g.markStuck('r1');
    expect(suspects).toEqual(['r1']);
    expect(g.stuckCount('r1')).toBe(1);
    expect(g.refuses('r1')).toBe(false);
    g.markStuck('r1');
    expect(g.refuses('r1')).toBe(true);
    expect(g.refuses('r2')).toBe(false);
    await expect(g.run('r1', { op: 'stat', path: 'ok' })).rejects.toMatchObject({ scanRootId: 'r1', reason: 'timeout' });
    expect(g.stuckCount()).toBe(2);
    g.clear('r1');
    expect(g.stuckCount()).toBe(0);
    expect(g.refuses('r1')).toBe(false);
    expect(await g.run('r1', { op: 'stat', path: 'ok' })).toBe('ok');
  });

  it('close lets go of every helper and refuses new work', async () => {
    const g = gate();
    const hung = g.run('r1', { op: 'readSmall', path: 'hang' }).catch((e: unknown) => e);
    expect(await g.run('r2', { op: 'stat', path: 'ok' })).toBe('ok');
    await g.close();
    expect(await hung).toMatchObject({ message: expect.stringMatching(/closed/) });
    await expect(g.run('r1', { op: 'stat', path: 'ok' })).rejects.toThrow(/closed/);
    expect(fakeHelpers()).toEqual([]);
  });
});

describe('FileGate probes (the folder watch)', () => {
  it('a probe passes the stuck cap, so a root at the cap can still read online', async () => {
    const g = gate({ stuckMax: 1 });
    await expect(g.run('r1', { op: 'stat', path: 'hang' })).rejects.toBeInstanceOf(FolderOfflineError);
    expect(g.refuses('r1')).toBe(true);
    await expect(g.run('r1', { op: 'stat', path: 'ok' })).rejects.toMatchObject({ reason: 'timeout' });
    expect(await g.run('r1', { op: 'stat', path: 'ok' }, { probe: true })).toBe('ok');
  });

  it('an offline answer to a probe carries its code', async () => {
    await expect(gate().run('r1', { op: 'stat', path: 'eio' }, { probe: true })).rejects.toMatchObject({ reason: 'io_error', code: 'EIO' });
  });

  it('reads a deadline at once, forking nothing, while the root\'s last probe helper has not exited', async () => {
    let again: Promise<unknown> | null = null;
    // onSuspect runs inside the deadline, before the killed helper can have exited
    const g = new FileGate({ helperPath: FAKE, limits: { waitMs: 300, idleMs: 1_500, helpers: 2, stuckMax: 4 }, onSuspect: (id) => {
      if (again === null) again = g.run(id, { op: 'stat', path: 'ok' }, { probe: true });
    } });
    made.push(g);
    await expect(g.run('r1', { op: 'stat', path: 'hang' }, { probe: true })).rejects.toMatchObject({ reason: 'timeout' });
    const t = Date.now();
    await expect(again).rejects.toMatchObject({ scanRootId: 'r1', reason: 'timeout' });
    expect(Date.now() - t).toBeLessThan(100);
    expect(g.stuckCount('r1')).toBe(1); // the held helper is not counted twice
    // another root's probe is not held back
    expect(await g.run('r2', { op: 'stat', path: 'ok' }, { probe: true })).toBe('ok');
    // once that helper is gone, the next probe forks again
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await g.run('r1', { op: 'stat', path: 'ok' }, { probe: true })).toBe('ok');
  });

  it('a probe goes ahead of queued work', async () => {
    const g = gate({ helpers: 1, waitMs: 5_000 });
    const order: string[] = [];
    const first = g.run('r1', { op: 'stat', path: 'slow:1' }).then((v) => order.push(String(v)));
    const queued = g.run('r1', { op: 'stat', path: 'work' }).then((v) => order.push(String(v)));
    const probe = g.run('r1', { op: 'stat', path: 'probe' }, { probe: true }).then((v) => order.push(String(v)));
    await Promise.all([first, queued, probe]);
    expect(order).toEqual(['slow:1', 'probe', 'work']);
  }, 10_000);
});

describe('isOfflineError', () => {
  it('knows a FolderOfflineError and the offline codes', () => {
    expect(isOfflineError(new FolderOfflineError('r1', 'timeout'))).toBe(true);
    for (const code of ['EIO', 'ETIMEDOUT', 'ESTALE', 'EHOSTDOWN', 'ENOTCONN']) expect(isOfflineError(Object.assign(new Error(code), { code }))).toBe(true);
    expect(isOfflineError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isOfflineError('EIO')).toBe(false);
  });
});

describe('gateLimits', () => {
  it('reads the helper counts from the environment, with defaults', () => {
    expect(gateLimits({})).toEqual({ waitMs: 15_000, idleMs: 60_000, helpers: 2, stuckMax: 4 });
    expect(gateLimits({ TAGAVE_FILE_HELPERS: '3', TAGAVE_FILE_HELPERS_STUCK_MAX: '6' })).toMatchObject({ helpers: 3, stuckMax: 6 });
    expect(gateLimits({ TAGAVE_FILE_HELPERS: '0', TAGAVE_FILE_HELPERS_STUCK_MAX: 'many' })).toMatchObject({ helpers: 2, stuckMax: 4 });
  });
});
