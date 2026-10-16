/**
 * "Disk space": free room on every filesystem tagave writes. 2026-10-15 the
 * production disk filled up during an update and Postgres crash-looped;
 * nothing tagave looked at said so.
 *
 * Measured with statfs only: no folder walks, so it answers in milliseconds
 * and cannot hang on a large cache. The health endpoint runs it every few
 * seconds, so each path's answer is kept for 30 s, a statfs that does not
 * answer (a stale NFS mount) gives up after 2 s, and a slow one is shared by
 * every caller instead of piling up.
 *
 * Paths: the backups folder (BACKUP_DIR, then CACHE_DIR/backups, the same
 * fallback the backups use), the cache folder, and Postgres's data folder
 * when Postgres runs on this machine. In Docker Postgres runs in its own
 * container, so its folder is not visible from here; the check says so
 * instead of guessing.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { defaultCacheDir } from '@tagave/core';
import { tagaveEnv } from '@tagave/shared/env';
import type { DiskFilesystemView, DiskPathKey, DiskPathView, DiskSpaceView, DiskUnmeasuredView } from '@tagave/shared';
import type { Check } from './checks.js';
import { defaultBackupDir } from './backup.js';

export const DEFAULT_DISK_WARN_PCT = 85;
export const DEFAULT_DISK_FAIL_PCT = 95;
const CACHE_MS = 30_000;
const STATFS_TIMEOUT_MS = 2_000;
const DATA_DIR_CACHE_MS = 10 * 60_000;

/** What the check needs from fs.statfs and fs.stat (a test seam). */
export interface DiskProbe {
  statfs(p: string): Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>;
  /** The device id, so two folders on one filesystem count once. */
  stat(p: string): Promise<{ dev: number }>;
}

const nodeProbe: DiskProbe = {
  statfs: (p) => fs.statfs(p),
  stat: (p) => fs.stat(p),
};

export interface DiskThresholds {
  warnPct: number;
  failPct: number;
}

function pct(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback;
}

/** TAGAVE_DISK_WARN_PCT and TAGAVE_DISK_FAIL_PCT; a warn above the fail level is lowered to it. */
export function readDiskThresholds(env: NodeJS.ProcessEnv = process.env): DiskThresholds {
  const failPct = pct(tagaveEnv('DISK_FAIL_PCT', env), DEFAULT_DISK_FAIL_PCT);
  const warnPct = Math.min(pct(tagaveEnv('DISK_WARN_PCT', env), DEFAULT_DISK_WARN_PCT), failPct);
  return { warnPct, failPct };
}

/** "8.8 GB": binary units, as df -h counts them. */
export function formatDiskBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Status of one filesystem from its used percentage. */
export function diskStatus(usedPct: number, t: DiskThresholds): DiskFilesystemView['status'] {
  if (usedPct >= t.failPct) return 'fail';
  if (usedPct >= t.warnPct) return 'warn';
  return 'pass';
}

/** One measured path, before filesystems are merged. */
export interface DiskReading {
  path: DiskPathView;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  dev: number | null;
}

/**
 * Readings grouped by filesystem: the same device, or (when the device is
 * not known) the same total and free bytes, is one filesystem. Fullest first.
 */
export function groupFilesystems(readings: DiskReading[], t: DiskThresholds): DiskFilesystemView[] {
  const groups: Array<{ head: DiskReading; paths: DiskPathView[] }> = [];
  for (const r of readings) {
    // two known devices decide; sizes only stand in when a device is unknown
    const same = groups.find(({ head }) => head.dev !== null && r.dev !== null
      ? head.dev === r.dev
      : head.totalBytes === r.totalBytes && head.freeBytes === r.freeBytes);
    if (same) same.paths.push(r.path);
    else groups.push({ head: r, paths: [r.path] });
  }
  return groups
    .map(({ head, paths }) => {
      const room = head.usedBytes + head.freeBytes;
      const raw = room > 0 ? (head.usedBytes / room) * 100 : 0;
      return {
        totalBytes: head.totalBytes,
        usedBytes: head.usedBytes,
        freeBytes: head.freeBytes,
        usedPct: Math.floor(raw * 10) / 10,
        status: diskStatus(raw, t),
        paths,
      };
    })
    .sort((a, b) => b.usedPct - a.usedPct);
}

const RANK = { pass: 0, warn: 1, fail: 2 } as const;

/**
 * The check as anyone may see it (the public /health): status words and the
 * thresholds, never a path, a size or a reason that names the host.
 */
export function publicDiskCheck(check: Check): Check {
  const disk = check.disk;
  const detail = !disk || disk.filesystems.length === 0
    ? 'Free space could not be read'
    : disk.status === 'fail' ? `A disk is almost full (${disk.failPct}% or more used)`
    : disk.status === 'warn' ? `A disk is filling up (${disk.warnPct}% or more used)`
    : 'Enough free space';
  return { id: check.id, title: check.title, status: check.status, detail, durationMs: check.durationMs };
}

/** The check's one-line detail: each filesystem with its paths, then what was not measured. */
export function diskDetail(view: Pick<DiskSpaceView, 'filesystems' | 'unmeasured'>): string {
  const parts = view.filesystems.map((fs) => {
    const where = fs.paths.map((p) => `${p.label} ${p.path}`).join(', ');
    return `${where}: ${Math.floor(fs.usedPct)}% used, ${formatDiskBytes(fs.freeBytes)} free of ${formatDiskBytes(fs.totalBytes)}`;
  });
  for (const u of view.unmeasured) parts.push(`${u.label}${u.path ? ` ${u.path}` : ''}: ${u.reason}`);
  return parts.join('. ') || 'Nothing to measure';
}

/** `p`, or a timeout error after `ms` (worded as `shownMs`, the whole allowance). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string, shownMs = ms): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timedOut(what, shownMs)), ms);
    timer.unref?.();
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}

function timedOut(what: string, ms = STATFS_TIMEOUT_MS): Error {
  return Object.assign(new Error(`${what} did not answer within ${ms / 1000} s`), { code: 'ETIMEDOUT' });
}

/**
 * One call per path at a time: a statfs on a mount that never answers holds
 * a libuv thread until it does, and there are only four. A later caller
 * shares a call that is still young; one already past the timeout fails at
 * once, so a health probe never waits on a mount known to hang.
 */
const inflight = new Map<string, { at: number; p: Promise<unknown> }>();
function once<T>(key: string, what: string, run: () => Promise<T>): Promise<T> {
  const pending = inflight.get(key);
  if (pending) {
    const age = Date.now() - pending.at;
    if (age >= STATFS_TIMEOUT_MS) return Promise.reject(timedOut(what));
    return withTimeout(pending.p as Promise<T>, STATFS_TIMEOUT_MS - age, what, STATFS_TIMEOUT_MS);
  }
  const p = run();
  const entry = { at: Date.now(), p };
  inflight.set(key, entry);
  const clear = () => { if (inflight.get(key) === entry) inflight.delete(key); };
  p.then(clear, clear);
  return withTimeout(p, STATFS_TIMEOUT_MS, what);
}

type Measured = { totalBytes: number; usedBytes: number; freeBytes: number; dev: number | null };
const readCache = new Map<string, { at: number; value: Promise<Measured> }>();

/**
 * Forget the cached answers (statfs results and failures, Postgres's data
 * folder). Safe to call at any time: calls still pending on a mount are kept,
 * so a hung mount still holds only one thread.
 */
export function resetDiskCache(): void {
  readCache.clear();
  dataDirCache.clear();
}

/** Tests only: also forget the pending calls (each test brings its own probe). */
export function resetDiskStateForTests(): void {
  resetDiskCache();
  inflight.clear();
}

/**
 * statfs of `target`, or of its nearest existing parent when it does not
 * exist yet (a cache or backups folder is created there, on that disk).
 * Only for missing paths: a database folder must be measured itself.
 */
async function measure(target: string, probe: DiskProbe, walkUp: boolean): Promise<Measured> {
  let at = path.resolve(target);
  for (;;) {
    try {
      const here = at;
      const what = `The disk at ${here}`;
      const s = await once(`statfs:${here}`, what, () => probe.statfs(here));
      const dev = await once(`stat:${here}`, what, () => probe.stat(here)).then((st) => st.dev, () => null);
      const totalBytes = s.blocks * s.bsize;
      const usedBytes = Math.max(0, (s.blocks - s.bfree) * s.bsize);
      return { totalBytes, usedBytes, freeBytes: s.bavail * s.bsize, dev };
    } catch (err) {
      const parent = path.dirname(at);
      if (!walkUp || (err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === at) throw err;
      at = parent;
    }
  }
}

function cachedMeasure(target: string, probe: DiskProbe, walkUp: boolean, fresh: boolean, now: number): Promise<Measured> {
  const key = `${walkUp ? 'w' : 'x'}:${target}`;
  const hit = readCache.get(key);
  if (hit && (hit.at === -1 || (!fresh && now - hit.at < CACHE_MS))) return hit.value;
  const entry = { at: -1, value: measure(target, probe, walkUp) };
  readCache.set(key, entry);
  // a failure (a hung mount included) is kept as long as an answer: probes
  // in the next 30 s get it at once instead of waiting on the mount again
  const settled = () => { entry.at = Date.now(); };
  entry.value.then(settled, settled);
  return entry.value;
}

const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);

/** The host Postgres runs on, from DATABASE_URL; '' for a Unix socket. */
export function databaseHost(databaseUrl: string): string | null {
  // postgres://u:p@/db?host=/var/run/postgresql has no URL host at all
  if (/[?&]host=(\/|%2F)/i.test(databaseUrl)) return '';
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return null;
  }
}

const dataDirCache = new Map<string, { at: number; value: Promise<string> }>();

async function showDataDirectory(databaseUrl: string): Promise<string> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 3, idle_timeout: 1, onnotice: () => undefined });
  try {
    const rows = await sql`show data_directory`;
    const dir = rows[0]?.['data_directory'];
    if (typeof dir !== 'string' || !dir) throw new Error('Postgres did not name its data folder');
    return dir;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

export interface DiskSpaceOptions {
  databaseUrl?: string;
  /** The cache folder; CACHE_DIR, then defaultCacheDir(home), as the cache check does. */
  cacheDir?: string;
  /** The backups folder; defaultBackupDir(env) when absent. */
  backupDir?: string;
  env?: NodeJS.ProcessEnv;
  probe?: DiskProbe;
  /** Where Postgres keeps its data, or why that is not known (test seam). */
  dataDirectory?: (databaseUrl: string) => Promise<string>;
  /** Skip the 30 s cache (the Storage page's Refresh). */
  fresh?: boolean;
}

/** Free space on every filesystem tagave writes. Never throws. */
export async function diskSpace(opts: DiskSpaceOptions = {}): Promise<DiskSpaceView> {
  const env = opts.env ?? process.env;
  const probe = opts.probe ?? nodeProbe;
  const thresholds = readDiskThresholds(env);
  const now = Date.now();
  const fresh = opts.fresh ?? false;
  const targets: Array<{ path: DiskPathView; walkUp: boolean }> = [
    { path: { key: 'backups', label: 'Backups', path: opts.backupDir ?? defaultBackupDir(env) }, walkUp: true },
    { path: { key: 'cache', label: 'Cache', path: opts.cacheDir || env['CACHE_DIR'] || defaultCacheDir(os.homedir()) }, walkUp: true },
  ];
  const unmeasured: DiskUnmeasuredView[] = [];
  const db = (reason: string, p: string | null = null) => unmeasured.push({ key: 'database' as DiskPathKey, label: 'Database', path: p, reason });

  if (opts.databaseUrl) {
    const host = databaseHost(opts.databaseUrl);
    if (host === null || !LOCAL_HOSTS.has(host)) {
      db(`Postgres runs on ${host ? `"${host}"` : 'another host'}, so its disk cannot be measured from here. Run df -h on the machine that holds its data (in Docker, the Docker host)`);
    } else {
      const lookup = opts.dataDirectory ?? showDataDirectory;
      const hit = dataDirCache.get(opts.databaseUrl);
      let pending: Promise<string>;
      if (hit && now - hit.at < DATA_DIR_CACHE_MS) pending = hit.value;
      else {
        // a failure is kept as long as an answer: a role that may not read
        // the setting (42501) would otherwise open a failing connection on
        // every health probe
        pending = withTimeout(lookup(opts.databaseUrl), 5_000, 'Postgres');
        pending.catch(() => undefined);
        dataDirCache.set(opts.databaseUrl, { at: now, value: pending });
      }
      try {
        targets.push({ path: { key: 'database', label: 'Database', path: await pending }, walkUp: false });
      } catch (err) {
        const why = (err as { code?: unknown }).code === '42501'
          ? 'its database user needs pg_read_all_settings'
          : (err as Error).message;
        db(`Postgres did not say where it keeps its data (${why}), so its disk was not measured`);
      }
    }
  }

  const readings: DiskReading[] = [];
  await Promise.all(targets.map(async (t) => {
    try {
      const m = await cachedMeasure(t.path.path, probe, t.walkUp, fresh, now);
      readings.push({ path: t.path, ...m });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const why = t.path.key === 'database' && (code === 'ENOENT' || code === 'EACCES')
        ? 'it is not visible from here (Postgres runs in another container or as another user), so its disk was not measured'
        : `could not be measured: ${(err as Error).message}`;
      unmeasured.push({ ...t.path, reason: why });
    }
  }));
  // targets order, not the order the reads finished in
  const order = (k: DiskPathKey) => targets.findIndex((t) => t.path.key === k);
  readings.sort((a, b) => order(a.path.key) - order(b.path.key));
  unmeasured.sort((a, b) => order(a.key) - order(b.key));

  const filesystems = groupFilesystems(readings, thresholds);
  const worst = filesystems.reduce<DiskSpaceView['status']>((s, f) => (RANK[f.status] > RANK[s] ? f.status : s), 'pass');
  // nothing tagave writes could be measured: say so, never a quiet pass
  const status = filesystems.length === 0 ? 'warn' : worst;
  return { status, ...thresholds, checkedAt: new Date(now).toISOString(), filesystems, unmeasured };
}

/** The doctor check around diskSpace. */
export async function checkDisk(opts: DiskSpaceOptions = {}): Promise<Check & { disk: DiskSpaceView }> {
  const start = Date.now();
  const disk = await diskSpace(opts);
  const lead = disk.status === 'fail'
    ? `Disk almost full (${disk.failPct}% or more used). `
    : disk.status === 'warn' && disk.filesystems.length > 0 ? `Disk filling up (${disk.warnPct}% or more used). ` : '';
  return {
    id: 'disk',
    title: 'Disk Space',
    status: disk.status,
    detail: `${lead}${diskDetail(disk)}`,
    durationMs: Date.now() - start,
    disk,
  };
}
