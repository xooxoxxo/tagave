import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import { JobTimeoutError, inFlightSnapshot, tracked, withTimeout } from './watchdog.js';

it('logs the tracked job while the worker main thread is blocked', async () => {
  const module = new URL('./watchdog.ts', import.meta.url).href;
  const script = [
    'import { writeSync } from "node:fs";',
    'import { setTimeout } from "node:timers/promises";',
    'import { startWatchdog, tracked } from ' + JSON.stringify(module) + ';',
    'const watchdog = startWatchdog({ warn() {} }, { pingMs: 20, stallMs: 100 });',
    'await tracked("scan.root", "job-1", "test-root", async () => {',
    '  await setTimeout(300);',
    '  writeSync(2, "blocking\\n");',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1600);',
    '  writeSync(2, "resumed\\n");',
    '  await setTimeout(20);',
    '});',
    'await watchdog.stop();',
  ].join('\n');
  const { stderr } = await promisify(execFile)(
    process.execPath, ['--eval', script], { timeout: 5_000 },
  );
  const lines = stderr.trim().split('\n');
  const before = lines.indexOf('blocking');
  const after = lines.indexOf('resumed');
  expect(before).toBeGreaterThanOrEqual(0);
  expect(after).toBeGreaterThan(before);
  const warning = lines.slice(before + 1, after).find((line) => line.includes('"event loop stalled"'));
  expect(warning && JSON.parse(warning)).toMatchObject({
    msg: 'event loop stalled',
    inFlight: [{ queue: 'scan.root', jobId: 'job-1', label: 'test-root' }],
  });
}, 7_000);

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
