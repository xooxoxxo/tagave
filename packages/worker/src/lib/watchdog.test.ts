import { describe, it, expect } from 'vitest';
import { JobTimeoutError, inFlightSnapshot, tracked, withTimeout } from './watchdog.js';

describe('withTimeout', () => {
  it('passes a value through when the work settles in time', async () => {
    await expect(withTimeout(200, 'fast', async () => 42)).resolves.toBe(42);
  });

  it('rejects with JobTimeoutError when the work outlives the budget', async () => {
    const slow = () => new Promise<void>((r) => setTimeout(r, 300));
    await expect(withTimeout(30, 'slow job', slow)).rejects.toBeInstanceOf(JobTimeoutError);
    await expect(withTimeout(30, 'slow job', slow)).rejects.toThrow(/slow job timed out/);
  });

  it('propagates the work\'s own error unchanged', async () => {
    await expect(withTimeout(200, 'x', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});

describe('tracked', () => {
  it('lists the job while it runs and forgets it afterwards, even on failure', async () => {
    let seen: ReturnType<typeof inFlightSnapshot> = [];
    await tracked('identify.album', 'job-1', 'album-1', async () => { seen = inFlightSnapshot(); });
    expect(seen.map((j) => [j.queue, j.jobId, j.label])).toEqual([['identify.album', 'job-1', 'album-1']]);
    expect(inFlightSnapshot()).toEqual([]);

    await expect(tracked('identify.album', 'job-2', 'album-2', async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect(inFlightSnapshot()).toEqual([]);
  });
});
