/**
 * runMerges without a database: a deadlock or serialization failure gets one
 * more try, any other failure (or a second one) leaves that pair alone with a
 * logged reason, and the rest of the plan still merges. Merges that need a
 * re-parse come back in reparseIds (finishWalk hands them to scan.parse).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { WorkerContext } from './context.js';
import type { MatchFile } from './reconcileMatch.js';

const mergeFilePair = vi.fn();
vi.mock('./fileMerge.js', () => ({ mergeFilePair: (...args: unknown[]) => mergeFilePair(...args) }));
const repointSidecarImages = vi.fn(async () => 0);
const refreshPlayerAfterMoves = vi.fn(async () => false);
vi.mock('./moveEffects.js', () => ({
  repointSidecarImages: (...args: unknown[]) => repointSidecarImages(...(args as [])),
  refreshPlayerAfterMoves: (...args: unknown[]) => refreshPlayerAfterMoves(...(args as [])),
}));
const { runMerges, sqlDirname, earliestLastSeen, withLibraryLock, rowsInDirs } = await import('./reconcile.js');

const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-02T00:00:00Z');
const file = (id: string, relPath: string, sizeBytes: number, seen: Date): MatchFile => ({
  id, scanRootId: 'r', relPath, sizeBytes, mtime: 100, inode: null, durationMs: null, coreTagsDigest: null,
  audioHash: null, trackNo: null, discNo: null, firstSeenAt: seen, lastSeenAt: seen,
});
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('runMerges', () => {
  const warn = vi.fn();
  const ctx = { sql: {} as any, db: {} as any, boss: {} as any, logger: Object.assign(pino({ level: 'silent' }), { warn }) } as unknown as WorkerContext;
  const olds = ['a', 'b', 'c', 'd'].map((k, i) => file(`old-${k}`, `${k}/x.flac`, 10 + i, t0));
  const freshs = ['a', 'b', 'c', 'd'].map((k, i) => file(`new-${k}`, `${k}2/x.flac`, 10 + i, t1));
  const done = (oldId: string, reparse = false) => {
    const k = oldId.slice(4);
    return { kind: 'merged', oldId, libraryId: 'l', from: { scanRootId: 'r', relPath: `${k}/x.flac` }, to: { scanRootId: 'r', relPath: `${k}2/x.flac` }, reparse, removedAlbumIds: [] };
  };

  beforeEach(() => {
    mergeFilePair.mockReset(); warn.mockReset();
    repointSidecarImages.mockReset(); repointSidecarImages.mockImplementation(async () => 0);
    refreshPlayerAfterMoves.mockReset(); refreshPlayerAfterMoves.mockImplementation(async () => false);
  });

  it('retries a deadlock once, skips what keeps failing, merges the rest', async () => {
    const calls = new Map<string, number>();
    mergeFilePair.mockImplementation(async (_ctx: unknown, req: { oldId: string }) => {
      const n = (calls.get(req.oldId) ?? 0) + 1;
      calls.set(req.oldId, n);
      if (req.oldId === 'old-a' && n === 1) throw pgError('40P01');          // deadlock, then fine
      if (req.oldId === 'old-b') throw pgError('40001');                     // serialization, twice
      if (req.oldId === 'old-c') throw new Error('connection reset');        // not retryable
      return done(req.oldId, req.oldId === 'old-d');
    });
    const r = await runMerges(ctx, 1, olds, freshs, t1, false);
    expect(Object.fromEntries(calls)).toEqual({ 'old-a': 2, 'old-b': 2, 'old-c': 1, 'old-d': 1 });
    expect(r.merged).toBe(2);
    expect(r.outcomes.map((o) => o.oldId).sort()).toEqual(['old-a', 'old-d']);
    expect(r.mergedFreshIds.sort()).toEqual(['new-a', 'new-d']);
    expect(r.reparseIds).toEqual(['old-d']);
    expect(r.possibleMoves).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((c) => c[0].reason).sort()).toEqual(['40001: pg 40001', 'error: connection reset']);
    // the merged folders' sidecar covers follow, once, with this run's moves
    expect(repointSidecarImages).toHaveBeenCalledTimes(1);
    expect((repointSidecarImages.mock.calls[0] as unknown[])[1]).toEqual(r.moves);
    // the player is offered this run's outcomes, once
    expect(refreshPlayerAfterMoves).toHaveBeenCalledTimes(1);
    expect((refreshPlayerAfterMoves.mock.calls[0] as unknown[])[1]).toBe(r.outcomes);
  });

  it('a failing move effect logs a warning, keeps the result and does not skip the other effect', async () => {
    mergeFilePair.mockImplementation(async (_ctx: unknown, req: { oldId: string }) => done(req.oldId));
    const clean = await runMerges(ctx, 1, olds, freshs, t1, false);
    expect(warn).not.toHaveBeenCalled();

    refreshPlayerAfterMoves.mockImplementation(async () => { throw new Error('player probe down'); });
    const r1 = await runMerges(ctx, 1, olds, freshs, t1, false);
    expect(r1).toEqual(clean);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0].error).toContain('player probe down');

    warn.mockReset(); refreshPlayerAfterMoves.mockReset(); refreshPlayerAfterMoves.mockImplementation(async () => false);
    repointSidecarImages.mockImplementation(async () => { throw new Error('sidecar update failed'); });
    const r2 = await runMerges(ctx, 1, olds, freshs, t1, false);
    expect(r2).toEqual(clean);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0].error).toContain('sidecar update failed');
    expect(refreshPlayerAfterMoves).toHaveBeenCalledTimes(1);
  });
});

describe('sqlDirname', () => {
  it('takes only a plain alias', () => {
    expect(sqlDirname('af')).toContain("strpos(af.rel_path, '/') = 0 then ''");
    expect(() => sqlDirname('af; drop table x')).toThrow();
  });
});

const BIG = 300_000;

describe('earliestLastSeen', () => {
  it('handles 300k rows (Math.min(...xs) throws RangeError past ~125k)', () => {
    const rows = Array.from({ length: BIG }, (_, i) => file(`o${i}`, `d/${i}.flac`, i, new Date(t1.getTime() + i)));
    rows[123_456] = file('early', 'd/e.flac', 1, t0);
    expect(earliestLastSeen(rows)).toEqual(t0);
  });
});

describe('rowsInDirs without a database', () => {
  it('appends 300k-row query results without spreading them into a call', async () => {
    const raw = Array.from({ length: BIG }, (_, i) => ({
      id: `f${i}`, scan_root_id: 'r', rel_path: `F/${i}.flac`, size_bytes: i, mtime: 1, inode: null,
      duration_ms: null, core_tags_digest: null, audio_hash: null, track_no: null, disc_no: null,
      first_seen_ms: t0.getTime(), last_seen_ms: t0.getTime(),
    }));
    // Every tagged call returns the 300k rows; fragments are never awaited, the two lookups are.
    const sql = Object.assign((..._args: unknown[]) => Promise.resolve(raw), { unsafe: () => Promise.resolve(raw) });
    const got = await rowsInDirs({ sql } as any, 'lib', [{ scanRootId: 'r', dirPath: '' }, { scanRootId: 'r', dirPath: 'F' }], {} as any);
    expect(got).toHaveLength(2 * BIG);              // nested batch + top-level query
    expect(got[BIG + 5]).toMatchObject({ id: 'f5', relPath: 'F/5.flac', sizeBytes: 5 });
  });
});

describe('withLibraryLock without a database', () => {
  /** A reserved connection whose unlock answers `unlocked` or throws. */
  const fakeCtx = (unlock: () => unknown) => {
    const released = vi.fn();
    const conn = Object.assign(async (strings: TemplateStringsArray) => {
      if (strings.join('').includes('pg_advisory_unlock')) return [{ unlocked: unlock() }];
      return [{}];
    }, { release: released });
    const warn = vi.fn();
    return { ctx: { sql: { reserve: async () => conn } as any, logger: { warn } }, released, warn };
  };

  it('warns when the lock was not held at unlock', async () => {
    const { ctx, released, warn } = fakeCtx(() => false);
    await expect(withLibraryLock(ctx, 'lib', async () => 7)).resolves.toBe(7);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("rethrows fn's error, not the unlock error, and logs the unlock error", async () => {
    const { ctx, released, warn } = fakeCtx(() => { throw new Error('unlock broke'); });
    await expect(withLibraryLock(ctx, 'lib', async () => { throw new Error('fn broke'); })).rejects.toThrow('fn broke');
    expect(warn.mock.calls[0]![0]).toMatchObject({ err: 'unlock broke' });
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unlock error when fn succeeded', async () => {
    const { ctx, released } = fakeCtx(() => { throw new Error('unlock broke'); });
    await expect(withLibraryLock(ctx, 'lib', async () => 1)).rejects.toThrow('unlock broke');
    expect(released).toHaveBeenCalledTimes(1);
  });
});
