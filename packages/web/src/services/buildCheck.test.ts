/**
 * The open tab against a newer server build: comparing builds, the shared
 * check (throttle, cross-tab), and the guarded reload when a lazy page's
 * code is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOCUS_GAP_MS,
  RELOAD_GUARD_MS,
  checkForNewBuild,
  getNewBuild,
  isNewBuild,
  knownSha,
  reloadForMissingChunk,
  reloadIntoNewBuild,
  resetBuildCheckForTests,
  startBuildWatch,
} from './buildCheck';

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

describe('knownSha / isNewBuild', () => {
  it('treats the dev and unknown markers as no build', () => {
    expect(knownSha('dev')).toBeNull();
    expect(knownSha('unknown')).toBeNull();
    expect(knownSha('')).toBeNull();
    expect(knownSha(null)).toBeNull();
    expect(knownSha(' ABC1234 ')).toBe('abc1234');
  });

  it('is new only when both sides know their sha and they differ', () => {
    expect(isNewBuild('a4c7662', 'b5d8773')).toBe(true);
    expect(isNewBuild('a4c7662', 'a4c7662')).toBe(false);
    expect(isNewBuild('A4C7662', 'a4c7662')).toBe(false);
  });

  it('never for a dev bundle or a server that does not know its sha', () => {
    expect(isNewBuild('dev', 'b5d8773')).toBe(false);
    expect(isNewBuild('a4c7662', null)).toBe(false);
    expect(isNewBuild('a4c7662', 'unknown')).toBe(false);
    expect(isNewBuild(undefined, undefined)).toBe(false);
  });

  it('matches the short and the full sha of one commit', () => {
    const full = 'a4c76621f0e9d0c3b1a2b3c4d5e6f708192a3b4c';
    expect(isNewBuild('a4c7662', full)).toBe(false);
    expect(isNewBuild(full, 'a4c7662')).toBe(false);
    expect(isNewBuild('a4c7662', 'b5d87731f0e9d0c3b1a2b3c4d5e6f708192a3b4c')).toBe(true);
    // too short to stand for a commit: compared as is
    expect(isNewBuild('a4c', full)).toBe(true);
  });
});

describe('checkForNewBuild', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let local: Storage;

  beforeEach(() => {
    local = fakeStorage();
    vi.stubGlobal('localStorage', local);
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: '0.7.7', sha: 'b5d8773' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    resetBuildCheckForTests({ sha: 'a4c7662', version: '0.7.6' });
  });

  afterEach(() => {
    resetBuildCheckForTests({ sha: 'dev', version: null });
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('finds the newer build the server runs', async () => {
    const found = await checkForNewBuild();
    expect(found).toEqual({ sha: 'b5d8773', version: '0.7.7' });
    expect(getNewBuild()).toEqual(found);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/version', expect.objectContaining({ cache: 'no-store' }));
  });

  it('finds nothing when the server runs this build', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ version: '0.7.6', sha: 'a4c7662' })));
    expect(await checkForNewBuild()).toBeNull();
    expect(getNewBuild()).toBeNull();
  });

  it('never asks from a dev bundle', async () => {
    resetBuildCheckForTests({ sha: 'dev', version: null });
    expect(await checkForNewBuild()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives a server that is restarting', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    expect(await checkForNewBuild()).toBeNull();
    fetchMock.mockImplementation(async () => new Response('', { status: 502 }));
    expect(await checkForNewBuild()).toBeNull();
  });

  it('skips a throttled check when any tab asked recently (shared in localStorage)', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ sha: 'a4c7662' })));
    await checkForNewBuild({ minGapMs: FOCUS_GAP_MS });
    await checkForNewBuild({ minGapMs: FOCUS_GAP_MS });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    local.setItem('tagave:build-checked-at', String(Date.now() - FOCUS_GAP_MS - 1));
    await checkForNewBuild({ minGapMs: FOCUS_GAP_MS });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks once for checks that overlap', async () => {
    await Promise.all([checkForNewBuild(), checkForNewBuild(), checkForNewBuild()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks when the job stream reconnects, without the throttle', async () => {
    let fire: () => void = () => undefined;
    startBuildWatch((listener) => { fire = listener; return () => undefined; });
    local.setItem('tagave:build-checked-at', String(Date.now()));
    fire();
    await vi.waitFor(() => expect(getNewBuild()?.sha).toBe('b5d8773'));
  });

  it('reloads into the new build after an update, and only then', async () => {
    const reload = vi.fn();
    expect(await reloadIntoNewBuild({ reload, gapMs: 1 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    resetBuildCheckForTests({ sha: 'b5d8773', version: '0.7.7' });
    const again = vi.fn();
    expect(await reloadIntoNewBuild({ reload: again, gapMs: 1 })).toBe(false);
    expect(again).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(4); // one, then three tries
  });
});

describe('reloadForMissingChunk', () => {
  it('reloads once, then not again within the guard', () => {
    const store = fakeStorage();
    const reload = vi.fn();
    const t0 = 1_000_000;
    expect(reloadForMissingChunk({ now: t0, store, online: true, reload })).toBe(true);
    expect(reloadForMissingChunk({ now: t0 + 5_000, store, online: true, reload })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again for a later update in the same tab', () => {
    const store = fakeStorage();
    const reload = vi.fn();
    reloadForMissingChunk({ now: 1_000_000, store, online: true, reload });
    expect(reloadForMissingChunk({ now: 1_000_000 + RELOAD_GUARD_MS + 1, store, online: true, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload offline or without sessionStorage to guard the loop', () => {
    const reload = vi.fn();
    expect(reloadForMissingChunk({ store: fakeStorage(), online: false, reload })).toBe(false);
    expect(reloadForMissingChunk({ store: null, online: true, reload })).toBe(false);
    const broken = { ...fakeStorage(), getItem: () => { throw new Error('denied'); } } as Storage;
    expect(reloadForMissingChunk({ store: broken, online: true, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
