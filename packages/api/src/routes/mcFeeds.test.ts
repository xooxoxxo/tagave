/** The one-at-a-time lane behind the /mc/v1 bearer gate (routes/mcFeeds.ts). */
import { describe, expect, it } from 'vitest';
import { LANE_DROPPED, LANE_FULL, MAX_LANE_WAITING, inLane } from './mcFeeds.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('inLane', () => {
  it('runs one at a time, in order, and refuses at once past MAX_LANE_WAITING waiting', async () => {
    const gate = deferred();
    const order: number[] = [];
    const first = inLane('cap', async () => {
      await gate.promise;
      order.push(0);
      return 0;
    });
    // let the first start: it is running, not waiting
    await Promise.resolve();
    await Promise.resolve();
    const queued = Array.from({ length: MAX_LANE_WAITING }, (_, i) =>
      inLane('cap', async () => {
        order.push(i + 1);
        return i + 1;
      }),
    );
    expect(await inLane('cap', async () => -1)).toBe(LANE_FULL);
    // another address has its own lane
    expect(await inLane('other', async () => 7)).toBe(7);
    gate.resolve();
    expect(await first).toBe(0);
    expect(await Promise.all(queued)).toEqual(Array.from({ length: MAX_LANE_WAITING }, (_, i) => i + 1));
    expect(order).toEqual(Array.from({ length: MAX_LANE_WAITING + 1 }, (_, i) => i));
    // drained: room again
    expect(await inLane('cap', async () => 1)).toBe(1);
  });

  it('drops a waiting lookup whose client has gone, without running it', async () => {
    const gate = deferred();
    let gone = false;
    let ran = false;
    const first = inLane('drop', async () => gate.promise);
    const waiting = inLane(
      'drop',
      async () => {
        ran = true;
        return 1;
      },
      () => gone,
    );
    gone = true;
    gate.resolve();
    await first;
    expect(await waiting).toBe(LANE_DROPPED);
    expect(ran).toBe(false);
  });

  it('a lookup that throws does not stop the ones after it', async () => {
    const failing = inLane('err', async () => {
      throw new Error('db down');
    });
    const next = inLane('err', async () => 2);
    await expect(failing).rejects.toThrow('db down');
    expect(await next).toBe(2);
  });
});
