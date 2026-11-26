/**
 * The cross-process lock of repairs and self-heal attempts: two RepairLock
 * objects on one install folder stand for two processes (the updater service
 * and the installer's one-off cli.js repair).
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { REPAIR_LOCK_FILE, RepairLock } from './repair-lock.js';

let dir: string;
let now: number;
const lockOf = (over: { staleMs?: number; beatMs?: number } = {}) => new RepairLock({ installDir: dir, now: () => now, ...over });
const onDisk = async () => JSON.parse(await readFile(join(dir, REPAIR_LOCK_FILE), 'utf8')) as { token: string; holder: string; at: string };
const exists = async () => (await readdir(join(dir, '.updater'))).includes('repair.lock');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tagave-repair-lock-'));
  now = Date.parse('2026-11-26T10:00:00.000Z');
});

describe('repair.lock', () => {
  it('one holder at a time: the second is told who holds it, and gets it once released', async () => {
    const service = lockOf();
    const installer = lockOf();
    const a = await service.acquire('heal');
    expect(a.ok).toBe(true);
    expect(await onDisk()).toMatchObject({ holder: 'heal', at: '2026-11-26T10:00:00.000Z' });
    expect(await installer.acquire('repair')).toEqual({ ok: false, holder: 'heal' });
    if (a.ok) await a.release();
    expect(await exists()).toBe(false);
    const b = await installer.acquire('repair');
    expect(b.ok).toBe(true);
    expect(await service.acquire('heal')).toEqual({ ok: false, holder: 'repair' });
  });

  it('of two at the same moment, exactly one gets it', async () => {
    const got = await Promise.all(Array.from({ length: 6 }, (_, i) => lockOf().acquire(i % 2 ? 'repair' : 'heal')));
    expect(got.filter((g) => g.ok)).toHaveLength(1);
  });

  it('a release removes only its own lock, and twice is harmless', async () => {
    const a = await lockOf({ staleMs: 1000 }).acquire('repair');
    expect(a.ok).toBe(true);
    // the holder stalled past staleMs: another process took the lock over
    now += 5000;
    const b = await lockOf({ staleMs: 1000 }).acquire('repair');
    expect(b.ok).toBe(true);
    const taken = await onDisk();
    if (a.ok) {
      await a.release();
      await a.release();
    }
    expect(await onDisk()).toEqual(taken);
    // the stale one was moved aside and removed: only the lock is left
    expect(await readdir(join(dir, '.updater'))).toEqual(['repair.lock']);
  });

  it('a lock left by a process that died is taken over once stale, never before', async () => {
    await mkdir(join(dir, '.updater'));
    await writeFile(join(dir, REPAIR_LOCK_FILE), JSON.stringify({ token: 'dead', holder: 'repair', at: new Date(now).toISOString() }));
    expect(await lockOf().acquire('heal')).toEqual({ ok: false, holder: 'repair' });
    now += 89_000;
    expect(await lockOf().acquire('heal')).toEqual({ ok: false, holder: 'repair' });
    now += 1000;
    const got = await lockOf().acquire('heal');
    expect(got.ok).toBe(true);
    expect(await onDisk()).toMatchObject({ holder: 'heal' });
  });

  it('a second taker of a stale lock never leaves the path empty, so a third cannot slip in', async () => {
    await mkdir(join(dir, '.updater'));
    await writeFile(join(dir, REPAIR_LOCK_FILE), JSON.stringify({ token: 'dead', holder: 'repair', at: new Date(now).toISOString() }));
    now += 100_000;
    const seen = { token: 'dead', holder: 'repair' as const, at: new Date(now - 100_000).toISOString() };
    // the first taker has the lock already
    const a = await lockOf().acquire('repair');
    expect(a.ok).toBe(true);
    const fresh = await onDisk();
    // the second taker judged the dead lock stale before that; while it looks at what it took, a third tries
    const b = lockOf();
    let third: Awaited<ReturnType<RepairLock['acquire']>> | null = null;
    const read = b['read'].bind(b);
    b['read'] = async (path: string) => {
      if (path.endsWith('.stale') && third === null) third = await lockOf().acquire('heal');
      return read(path);
    };
    expect(await b['takeOver'](seen)).toBe(false);
    expect(third).toEqual({ ok: false, holder: 'repair' });
    expect(await onDisk()).toEqual(fresh);
    expect(await readdir(join(dir, '.updater'))).toEqual(['repair.lock']);
    if (a.ok) await a.release();
  });

  it('a holder writes its time again, so a long repair never looks stale', async () => {
    const a = await lockOf({ beatMs: 10, staleMs: 90_000 }).acquire('repair');
    expect(a.ok).toBe(true);
    now += 60_000;
    await new Promise((r) => setTimeout(r, 60));
    expect((await onDisk()).at).toBe(new Date(now).toISOString());
    now += 60_000;
    // 120 s after it was taken, 60 s after its last write: still held
    expect(await lockOf().acquire('heal')).toEqual({ ok: false, holder: 'repair' });
    if (a.ok) await a.release();
  });

  it('a lock half written (no body yet) counts as held while the file is new', async () => {
    await mkdir(join(dir, '.updater'));
    await writeFile(join(dir, REPAIR_LOCK_FILE), '');
    const real = new RepairLock({ installDir: dir });
    expect(await real.acquire('heal')).toEqual({ ok: false, holder: 'repair' });
  });

  it('a folder that cannot be written: not taken, and nobody is named', async () => {
    if (process.getuid?.() === 0) return; // root writes anyway
    await mkdir(join(dir, '.updater'));
    await chmod(join(dir, '.updater'), 0o500);
    try {
      expect(await lockOf().acquire('repair')).toEqual({ ok: false, holder: null });
    } finally {
      await chmod(join(dir, '.updater'), 0o700);
    }
  });
});
