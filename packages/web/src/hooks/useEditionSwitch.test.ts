/**
 * "Use this edition": the mutation stays pending until the album and the
 * editions have been read again, writes only what the server answered, and a
 * repeat click while it runs does nothing. Driven through query-core's
 * MutationObserver, the same machine useMutation runs on.
 */
import { describe, expect, it, vi } from 'vitest';
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/query-core';
import { albumQueryKey, editionsQueryKey, singleFlight, switchEditionOptions, type SwitchEditionResponse } from './useEditionSwitch';

const LIB = 'lib1';
const ALBUM = 'album1';
const OLD = 'mbid-old';
const NEW = 'mbid-new';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** a client with the album and editions queries mounted, their reads under the test's control */
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const albumReads: Array<ReturnType<typeof deferred<unknown>>> = [];
  const editionReads: Array<ReturnType<typeof deferred<unknown>>> = [];
  const album = new QueryObserver(qc, {
    queryKey: albumQueryKey(ALBUM),
    queryFn: () => { const d = deferred<unknown>(); albumReads.push(d); return d.promise; },
    staleTime: Infinity,
  });
  const editions = new QueryObserver(qc, {
    queryKey: editionsQueryKey(LIB, ALBUM),
    queryFn: () => { const d = deferred<unknown>(); editionReads.push(d); return d.promise; },
    staleTime: Infinity,
  });
  qc.setQueryData(albumQueryKey(ALBUM), { id: ALBUM, pendingIdentify: null, identifyRequest: null });
  qc.setQueryData(editionsQueryKey(LIB, ALBUM), { editions: [{ mbid: OLD, owned: true }, { mbid: NEW, owned: false }] });
  // mounted, as on the page
  const unsubs = [album.subscribe(() => {}), editions.subscribe(() => {})];
  return { qc, albumReads, editionReads, close: () => unsubs.forEach((u) => u()) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('switchEditionOptions', () => {
  it('stays pending until the album and the editions are read again; no swap before the server answers', async () => {
    const { qc, albumReads, editionReads, close } = setup();
    const posted = deferred<SwitchEditionResponse>();
    const post = vi.fn((_path: string, _body: unknown) => posted.promise);
    const m = new MutationObserver(qc, switchEditionOptions(qc, LIB, ALBUM, post));
    const run = m.mutate(NEW);

    await flush();
    expect(post).toHaveBeenCalledWith(`/libraries/${LIB}/albums/${ALBUM}/match-mbid`, { input: NEW });
    expect(m.getCurrentResult()).toMatchObject({ isPending: true, variables: NEW });
    // nothing on screen has moved: the old edition is still the copy
    expect(qc.getQueryData<any>(editionsQueryKey(LIB, ALBUM)).editions[0]).toMatchObject({ mbid: OLD, owned: true });
    expect(albumReads).toHaveLength(0);

    const pending = { id: 'job1', state: 'created', kind: 'mbid', pinned: NEW, priority: 100, createdAt: 'now', startedAt: null, jobsAhead: 0 };
    posted.resolve({ ok: true, jobId: 'job1', pending: pending as any, identifyRequest: { status: 'queued', kind: 'mbid', pinned: NEW } as any });
    await flush();
    // the server's answer is in the album cache at once
    expect(qc.getQueryData<any>(albumQueryKey(ALBUM)).pendingIdentify).toMatchObject({ id: 'job1', pinned: NEW });
    // and both reads are on their way, the mutation still pending
    expect(albumReads).toHaveLength(1);
    expect(editionReads).toHaveLength(1);
    expect(m.getCurrentResult().isPending).toBe(true);

    albumReads[0]!.resolve({ id: ALBUM, pendingIdentify: pending, identifyRequest: null });
    await flush();
    expect(m.getCurrentResult().isPending).toBe(true);
    editionReads[0]!.resolve({ editions: [{ mbid: OLD, owned: true }, { mbid: NEW, owned: false }] });
    await run;
    expect(m.getCurrentResult()).toMatchObject({ isPending: false, isSuccess: true });
    close();
  });

  it('a failed request writes nothing and reports the server\'s reason', async () => {
    const { qc, albumReads, editionReads, close } = setup();
    const post = vi.fn(async () => { throw { status: 409, detail: 'An identification request is already queued for this album' }; });
    const m = new MutationObserver(qc, switchEditionOptions(qc, LIB, ALBUM, post));
    await m.mutate(NEW).catch(() => {});
    expect(m.getCurrentResult()).toMatchObject({ isError: true, variables: NEW });
    expect((m.getCurrentResult().error as any).detail).toMatch(/already queued/);
    expect(qc.getQueryData<any>(albumQueryKey(ALBUM)).pendingIdentify).toBeNull();
    expect(qc.getQueryData<any>(editionsQueryKey(LIB, ALBUM)).editions[0].owned).toBe(true);
    expect(albumReads).toHaveLength(0);
    expect(editionReads).toHaveLength(0);
    close();
  });
});

describe('singleFlight', () => {
  it('drops repeat calls until the first one is done', () => {
    const calls: string[] = [];
    let finish = () => {};
    const go = singleFlight<string>((mbid, done) => { calls.push(mbid); finish = done; });
    expect(go('a')).toBe(true);
    expect(go('a')).toBe(false); // the double click
    expect(go('b')).toBe(false); // another row while the first runs
    expect(calls).toEqual(['a']);
    finish();
    expect(go('b')).toBe(true);
    expect(calls).toEqual(['a', 'b']);
  });
});
