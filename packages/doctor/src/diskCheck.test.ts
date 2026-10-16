/**
 * The disk check with an injected statfs: thresholds, one entry per
 * filesystem, the wording, and that it neither hangs nor re-reads every probe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkDisk,
  databaseHost,
  diskDetail,
  diskSpace,
  formatDiskBytes,
  groupFilesystems,
  publicDiskCheck,
  readDiskThresholds,
  resetDiskCache,
  resetDiskStateForTests,
  type DiskProbe,
  type DiskReading,
} from './diskCheck.js';

const GB = 1024 ** 3;
const T = { warnPct: 85, failPct: 95 };

/** A filesystem of `total` GB with `used` GB used (no root reserve), on device `dev`. */
const fsOf = (totalGb: number, usedGb: number, dev: number) => ({
  statfs: { bsize: 4096, blocks: (totalGb * GB) / 4096, bfree: ((totalGb - usedGb) * GB) / 4096, bavail: ((totalGb - usedGb) * GB) / 4096 },
  dev,
});

function probeOf(map: Record<string, ReturnType<typeof fsOf>>): DiskProbe & { calls: string[] } {
  const calls: string[] = [];
  const find = (p: string) => {
    const hit = map[p];
    if (!hit) throw Object.assign(new Error(`ENOENT: no such file or directory, statfs '${p}'`), { code: 'ENOENT' });
    return hit;
  };
  return {
    calls,
    statfs: async (p) => { calls.push(p); return find(p).statfs; },
    stat: async (p) => ({ dev: find(p).dev }),
  };
}

const env = { BACKUP_DIR: '/backups', CACHE_DIR: '/cache' } as NodeJS.ProcessEnv;

beforeEach(() => resetDiskStateForTests());
afterEach(() => vi.useRealTimers());

describe('readDiskThresholds', () => {
  it('defaults to warn at 85 % and fail at 95 %', () => {
    expect(readDiskThresholds({})).toEqual({ warnPct: 85, failPct: 95 });
  });

  it('takes TAGAVE_DISK_WARN_PCT / TAGAVE_DISK_FAIL_PCT, then the LINER_ names', () => {
    expect(readDiskThresholds({ TAGAVE_DISK_WARN_PCT: '70', TAGAVE_DISK_FAIL_PCT: '90' })).toEqual({ warnPct: 70, failPct: 90 });
    expect(readDiskThresholds({ LINER_DISK_WARN_PCT: '75' })).toEqual({ warnPct: 75, failPct: 95 });
  });

  it('ignores nonsense and never warns above the fail level', () => {
    expect(readDiskThresholds({ TAGAVE_DISK_WARN_PCT: 'lots', TAGAVE_DISK_FAIL_PCT: '150' })).toEqual({ warnPct: 85, failPct: 95 });
    expect(readDiskThresholds({ TAGAVE_DISK_WARN_PCT: '0' })).toEqual({ warnPct: 85, failPct: 95 });
    expect(readDiskThresholds({ TAGAVE_DISK_WARN_PCT: '90', TAGAVE_DISK_FAIL_PCT: '80' })).toEqual({ warnPct: 80, failPct: 80 });
  });
});

describe('groupFilesystems', () => {
  const reading = (key: 'backups' | 'cache' | 'database', p: string, usedGb: number, totalGb: number, dev: number | null): DiskReading => ({
    path: { key, label: key, path: p }, totalBytes: totalGb * GB, usedBytes: usedGb * GB, freeBytes: (totalGb - usedGb) * GB, dev,
  });

  it('counts two folders on one device once, with both paths', () => {
    const out = groupFilesystems([reading('backups', '/backups', 40, 50, 7), reading('cache', '/cache', 40, 50, 7)], T);
    expect(out).toHaveLength(1);
    expect(out[0]!.paths.map((p) => p.path)).toEqual(['/backups', '/cache']);
  });

  it('merges by total and free when the device is unknown, and keeps different disks apart', () => {
    expect(groupFilesystems([reading('backups', '/b', 10, 50, null), reading('cache', '/c', 10, 50, null)], T)).toHaveLength(1);
    expect(groupFilesystems([reading('backups', '/b', 10, 50, 1), reading('cache', '/c', 10, 50, null)], T)).toHaveLength(1);
    // two known devices that differ are two disks, even of the same size and fill
    expect(groupFilesystems([reading('backups', '/b', 10, 50, 1), reading('cache', '/c', 10, 50, 2)], T)).toHaveLength(2);
    const two = groupFilesystems([reading('backups', '/b', 10, 50, 1), reading('cache', '/c', 48, 50, 2)], T);
    expect(two.map((f) => f.status)).toEqual(['fail', 'pass']); // fullest first
  });

  it('warns at the warn level and fails at the fail level, as df counts them', () => {
    const at = (used: number) => groupFilesystems([reading('cache', '/c', used, 100, 1)], T)[0]!;
    expect(at(84.9).status).toBe('pass');
    expect(at(85).status).toBe('warn');
    expect(at(94.9).status).toBe('warn');
    expect(at(95).status).toBe('fail');
    expect(at(84.99).usedPct).toBe(84.9); // rounded down, never shown as 85 while it passes
  });

  it('counts the root reserve as not free, like df', () => {
    // 100 GB disk, 80 GB used, 20 GB free of which 5 GB reserved for root
    const out = groupFilesystems([{ path: { key: 'cache', label: 'Cache', path: '/c' }, totalBytes: 100 * GB, usedBytes: 80 * GB, freeBytes: 15 * GB, dev: 1 }], T)[0]!;
    expect(out.usedPct).toBe(84.2);
  });
});

describe('formatting', () => {
  it('writes sizes in binary units', () => {
    expect(formatDiskBytes(512)).toBe('512 B');
    expect(formatDiskBytes(8.8 * GB)).toBe('8.8 GB');
    expect(formatDiskBytes(250 * GB)).toBe('250 GB');
    expect(formatDiskBytes(2 * 1024 * GB)).toBe('2.0 TB');
  });

  it('names each filesystem with its paths, then what was not measured', () => {
    const text = diskDetail({
      filesystems: [{ totalBytes: 50 * GB, usedBytes: 41 * GB, freeBytes: 9 * GB, usedPct: 82, status: 'pass', paths: [{ key: 'backups', label: 'Backups', path: '/backups' }, { key: 'cache', label: 'Cache', path: '/cache' }] }],
      unmeasured: [{ key: 'database', label: 'Database', path: null, reason: 'Postgres runs on "postgres"' }],
    });
    expect(text).toBe('Backups /backups, Cache /cache: 82% used, 9.0 GB free of 50.0 GB. Database: Postgres runs on "postgres"');
  });
});

describe('databaseHost', () => {
  it('reads the host, a socket as local, and nonsense as unknown', () => {
    expect(databaseHost('postgres://u:p@postgres:5432/tagave')).toBe('postgres');
    expect(databaseHost('postgres://u:p@127.0.0.1/tagave')).toBe('127.0.0.1');
    expect(databaseHost('postgres://u:p@/tagave?host=/var/run/postgresql')).toBe('');
    expect(databaseHost('not a url')).toBeNull();
  });
});

describe('diskSpace / checkDisk', () => {
  it('passes with one filesystem for backups and cache on the same disk', async () => {
    const probe = probeOf({ '/backups': fsOf(100, 40, 1), '/cache': fsOf(100, 40, 1) });
    const check = await checkDisk({ env, probe });
    expect(check).toMatchObject({ id: 'disk', title: 'Disk Space', status: 'pass' });
    expect(check.disk.filesystems).toHaveLength(1);
    expect(check.detail).toBe('Backups /backups, Cache /cache: 40% used, 60.0 GB free of 100 GB');
  });

  it('warns and fails with the worst filesystem, and leads with it', async () => {
    const warn = await checkDisk({ env, probe: probeOf({ '/backups': fsOf(100, 88, 1), '/cache': fsOf(100, 10, 2) }) });
    expect(warn.status).toBe('warn');
    expect(warn.detail).toMatch(/^Disk filling up \(85% or more used\)\. Backups \/backups: 88% used/);
    resetDiskCache();
    const fail = await checkDisk({ env, probe: probeOf({ '/backups': fsOf(100, 88, 1), '/cache': fsOf(100, 99, 2) }) });
    expect(fail.status).toBe('fail');
    expect(fail.detail).toMatch(/^Disk almost full \(95% or more used\)\. Cache \/cache: 99% used/);
  });

  it('honours the thresholds from the environment', async () => {
    const check = await checkDisk({ env: { ...env, TAGAVE_DISK_WARN_PCT: '30' }, probe: probeOf({ '/backups': fsOf(100, 40, 1), '/cache': fsOf(100, 40, 1) }) });
    expect(check.status).toBe('warn');
    expect(check.disk).toMatchObject({ warnPct: 30, failPct: 95 });
  });

  it('measures the disk a folder that does not exist yet would be created on', async () => {
    const view = await diskSpace({ env: { BACKUP_DIR: '/data/tagave/backups', CACHE_DIR: '/data/tagave/cache' }, probe: probeOf({ '/data': fsOf(10, 1, 3) }) });
    expect(view.filesystems).toHaveLength(1);
    expect(view.filesystems[0]!.paths.map((p) => p.path)).toEqual(['/data/tagave/backups', '/data/tagave/cache']);
  });

  it('falls back to CACHE_DIR/backups for the backups folder, as the backups do', async () => {
    const view = await diskSpace({ env: { CACHE_DIR: '/cache' }, probe: probeOf({ '/cache': fsOf(10, 1, 3) }) });
    expect(view.filesystems[0]!.paths).toEqual([
      { key: 'backups', label: 'Backups', path: '/cache/backups' },
      { key: 'cache', label: 'Cache', path: '/cache' },
    ]);
  });

  it('says Postgres on another host cannot be measured from here, without asking it', async () => {
    const dataDirectory = vi.fn(async () => '/var/lib/postgresql/data');
    const check = await checkDisk({ env, databaseUrl: 'postgres://u:p@postgres:5432/tagave', dataDirectory, probe: probeOf({ '/backups': fsOf(100, 40, 1), '/cache': fsOf(100, 40, 1) }) });
    expect(dataDirectory).not.toHaveBeenCalled();
    expect(check.status).toBe('pass');
    expect(check.disk.unmeasured).toEqual([expect.objectContaining({ key: 'database', path: null })]);
    expect(check.detail).toMatch(/Database: Postgres runs on "postgres", so its disk cannot be measured from here/);
  });

  it('measures a local Postgres data folder, and says when it is not visible', async () => {
    const url = 'postgres://u:p@localhost:5432/tagave';
    const seen = await diskSpace({ env, databaseUrl: url, dataDirectory: async () => '/pg', probe: probeOf({ '/backups': fsOf(100, 40, 1), '/cache': fsOf(100, 40, 1), '/pg': fsOf(500, 480, 9) }) });
    expect(seen.status).toBe('fail');
    expect(seen.filesystems[0]!.paths).toEqual([{ key: 'database', label: 'Database', path: '/pg' }]);
    resetDiskCache();
    const hidden = await diskSpace({ env, databaseUrl: url, dataDirectory: async () => '/pg', probe: probeOf({ '/backups': fsOf(100, 40, 1), '/cache': fsOf(100, 40, 1) }) });
    expect(hidden.status).toBe('pass');
    expect(hidden.unmeasured[0]).toMatchObject({ key: 'database', path: '/pg', reason: expect.stringMatching(/not visible from here/) });
  });

  it('warns rather than passes when nothing could be measured', async () => {
    const probe: DiskProbe = { statfs: async () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); }, stat: async () => ({ dev: 1 }) };
    const check = await checkDisk({ env, probe });
    expect(check.status).toBe('warn');
    expect(check.detail).toBe('Backups /backups: could not be measured: EIO: i/o error. Cache /cache: could not be measured: EIO: i/o error');
  });

  it('gives up on a mount that never answers, and keeps asking it only once', async () => {
    vi.useFakeTimers();
    const statfs = vi.fn(() => new Promise<never>(() => undefined));
    const probe: DiskProbe = { statfs, stat: async () => ({ dev: 1 }) };
    const first = checkDisk({ env, probe });
    await vi.advanceTimersByTimeAsync(2_100);
    const check = await first;
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/The disk at \/backups did not answer within 2 s/);
    const second = checkDisk({ env, probe });
    await vi.advanceTimersByTimeAsync(2_100);
    await second;
    expect(statfs).toHaveBeenCalledTimes(2); // one per path, not one per probe
  });

  it('answers at once while a mount hangs, also asked fresh, and never asks it twice', async () => {
    const statfs = vi.fn(() => new Promise<never>(() => undefined));
    const probe: DiskProbe = { statfs, stat: async () => ({ dev: 1 }) };
    const first = await checkDisk({ env, probe }); // real time: about 2 s
    expect(first.status).toBe('warn');
    for (const fresh of [false, true]) {
      const t = Date.now();
      const again = await checkDisk({ env, probe, fresh });
      expect(Date.now() - t, `fresh: ${fresh}`).toBeLessThan(50);
      expect(again.detail).toMatch(/did not answer within 2 s/);
    }
    expect(statfs).toHaveBeenCalledTimes(2); // one per path
    // a reset forgets the answers, not the call still hanging on the mount
    resetDiskCache();
    const t = Date.now();
    await checkDisk({ env, probe });
    expect(Date.now() - t).toBeLessThan(50);
    expect(statfs).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('keeps a failure for 30 s like an answer', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const probe: DiskProbe = { statfs: async () => { calls++; throw Object.assign(new Error('EIO'), { code: 'EIO' }); }, stat: async () => ({ dev: 1 }) };
    await diskSpace({ env, probe });
    await diskSpace({ env, probe });
    expect(calls).toBe(2);
    vi.advanceTimersByTime(31_000);
    await diskSpace({ env, probe });
    expect(calls).toBe(4);
  });

  it('asks Postgres for its data folder once per 10 minutes, also when it refuses', async () => {
    vi.useFakeTimers();
    const url = 'postgres://u:p@localhost:5432/tagave';
    const dataDirectory = vi.fn(async () => { throw Object.assign(new Error('permission denied to examine "data_directory"'), { code: '42501' }); });
    const probe = probeOf({ '/backups': fsOf(100, 40, 1), '/cache': fsOf(100, 40, 1) });
    const first = await diskSpace({ env, databaseUrl: url, dataDirectory, probe });
    expect(first.unmeasured[0]).toMatchObject({ key: 'database', reason: 'Postgres did not say where it keeps its data (its database user needs pg_read_all_settings), so its disk was not measured' });
    const again = await diskSpace({ env, databaseUrl: url, dataDirectory, probe });
    expect(again.unmeasured[0]?.reason).toMatch(/pg_read_all_settings/);
    expect(dataDirectory).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(11 * 60_000);
    await diskSpace({ env, databaseUrl: url, dataDirectory, probe });
    expect(dataDirectory).toHaveBeenCalledTimes(2);
  });

  it('keeps an answer for 30 s unless asked fresh', async () => {
    vi.useFakeTimers();
    const probe = probeOf({ '/backups': fsOf(100, 40, 1), '/cache': fsOf(100, 40, 1) });
    await diskSpace({ env, probe });
    await diskSpace({ env, probe });
    expect(probe.calls).toHaveLength(2);
    await diskSpace({ env, probe, fresh: true });
    expect(probe.calls).toHaveLength(4);
    vi.advanceTimersByTime(31_000);
    await diskSpace({ env, probe });
    expect(probe.calls).toHaveLength(6);
  });
});

describe('publicDiskCheck', () => {
  it('keeps the status and says it in words, without paths or sizes', async () => {
    const url = 'postgres://u:p@postgres:5432/tagave';
    for (const [used, status, words] of [[40, 'pass', 'Enough free space'], [88, 'warn', 'A disk is filling up (85% or more used)'], [99, 'fail', 'A disk is almost full (95% or more used)']] as const) {
      resetDiskCache();
      const full = await checkDisk({ env, databaseUrl: url, probe: probeOf({ '/backups': fsOf(100, used, 1), '/cache': fsOf(100, used, 1) }) });
      const pub = publicDiskCheck(full);
      expect(pub).toEqual({ id: 'disk', title: 'Disk Space', status, detail: words, durationMs: full.durationMs });
      expect(JSON.stringify(pub)).not.toMatch(/\/|Bytes|GB/);
    }
  });

  it('says only that it could not read when nothing was measured', async () => {
    const probe: DiskProbe = { statfs: async () => { throw new Error('EIO /secret/path'); }, stat: async () => ({ dev: 1 }) };
    const pub = publicDiskCheck(await checkDisk({ env, probe }));
    expect(pub).toMatchObject({ status: 'warn', detail: 'Free space could not be read' });
  });
});
