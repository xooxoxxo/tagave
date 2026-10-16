import { describe, it, expect, vi } from 'vitest';
import { makeThumbRebuildRequester, REBUILD_REPEAT_MS } from './thumbRebuild.js';

describe('makeThumbRebuildRequester', () => {
  const setup = () => {
    let t = 1_000_000;
    const send = vi.fn(async () => 'job');
    const log = vi.fn();
    const request = makeThumbRebuildRequester({ getBoss: async () => ({ send }) as any, claimSweep: async () => true, now: () => t, log });
    return { request, send, log, advance: (ms: number) => { t += ms; } };
  };

  it('queues art.thumb by singleton key, plus one sweep', async () => {
    const { request, send } = setup();
    await request('img-1');
    expect(send).toHaveBeenCalledWith('art.thumb', { imageId: 'img-1' }, { singletonKey: 'thumb:img-1' });
    expect(send).toHaveBeenCalledWith('art.thumbSweep', {}, { singletonKey: 'art.thumbSweep' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('asks again for an image, or sweeps again, only after a while', async () => {
    const { request, send, advance } = setup();
    await request('img-1');
    await request('img-1');
    await request('img-2');
    // img-2 is new; the sweep is not re-sent
    expect(send.mock.calls.map((c: unknown[]) => c[0])).toEqual(['art.thumb', 'art.thumbSweep', 'art.thumb']);
    advance(REBUILD_REPEAT_MS);
    await request('img-1');
    expect(send.mock.calls.map((c: unknown[]) => c[0]).slice(3)).toEqual(['art.thumb', 'art.thumbSweep']);
  });

  it('sends no sweep when another process (or this one) asked in the last 30 minutes', async () => {
    const send = vi.fn(async () => 'job');
    const claimSweep = vi.fn(async () => false);
    const request = makeThumbRebuildRequester({ getBoss: async () => ({ send }) as any, claimSweep });
    await request('img-1');
    expect(claimSweep).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.map((c: unknown[]) => c[0])).toEqual(['art.thumb']);
  });

  it('past its limit it forgets the oldest requests, not all of them', async () => {
    let t = 0;
    const send = vi.fn(async () => 'job');
    const request = makeThumbRebuildRequester({ getBoss: async () => ({ send }) as any, claimSweep: async () => true, now: () => t }, 3);
    for (const id of ['a', 'b', 'c', 'd']) await request(id); // 'a' is forgotten
    const thumbs = () => send.mock.calls.filter((c: unknown[]) => c[0] === 'art.thumb').map((c: unknown[]) => (c[1] as { imageId: string }).imageId);
    expect(thumbs()).toEqual(['a', 'b', 'c', 'd']);
    t += 1;
    await request('c'); // still remembered: not asked again
    await request('a'); // forgotten: asked again
    expect(thumbs()).toEqual(['a', 'b', 'c', 'd', 'a']);
  });

  it('a failed send is logged, not thrown, and the next request tries again', async () => {
    const { request, send, log } = setup();
    send.mockRejectedValueOnce(new Error('queue down'));
    await expect(request('img-1')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith({ imageId: 'img-1', err: 'queue down' }, expect.any(String));
    await request('img-1');
    expect(send).toHaveBeenLastCalledWith('art.thumbSweep', {}, { singletonKey: 'art.thumbSweep' });
  });
});
