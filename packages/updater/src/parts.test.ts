/**
 * Stopping and starting parts one at a time, through a scripted fake Docker
 * with its own clock: a call that times out moves the clock on by its limit.
 */
import { describe, expect, it } from 'vitest';
import type { MusicProber, MusicReading, PartStuck } from './music-probe.js';
import { PART_LIMITS, Parts } from './parts.js';
import type { CommandResult, Runner } from './runner.js';

type Answer = Partial<CommandResult> | 'timeout' | 'reject';

function fake(script: (args: string[]) => Answer) {
  const calls: string[][] = [];
  const state = { clock: 1_000_000 };
  const docker: Runner = async (args, opts) => {
    calls.push(args);
    const a = script(args);
    if (a === 'reject') throw new Error('docker went away');
    if (a === 'timeout') {
      state.clock += opts?.timeoutMs ?? 0;
      return { code: 143, stdout: '', stderr: `timed out after ${Math.round((opts?.timeoutMs ?? 0) / 1000)} s` };
    }
    return { code: 0, stdout: '', stderr: '', ...a };
  };
  return { calls, state, docker };
}

function prober(reading: Partial<MusicReading> | null) {
  const reads: PartStuck[][] = [];
  const music: MusicProber = {
    async read({ parts }) {
      reads.push(parts);
      return reading && ({ verdict: 'ok', server: null, ...reading } as MusicReading);
    },
  };
  return { reads, music };
}

function parts(f: ReturnType<typeof fake>, music: MusicProber | null = null, lines: string[] = []) {
  return new Parts({ docker: f.docker, music, now: () => f.state.clock, log: (_l, m) => lines.push(m) });
}

const id = (svc: string) => `${svc}-c1`;
const isStop = (a: string[]) => a[0] === 'compose' && a[1] === 'stop';
const isPs = (a: string[]) => a[0] === 'compose' && a[1] === 'ps';
const isUp = (a: string[]) => a[0] === 'compose' && a[1] === 'up';

/** A part that will not stop: stop and kill time out, inspect always says running. */
const stuckStop = (a: string[]): Answer => {
  if (isStop(a) || a[0] === 'kill') return 'timeout';
  if (isPs(a)) return { stdout: `${id(a.at(-1)!)}\n` };
  if (a[0] === 'inspect') return { stdout: 'running\n' };
  return { code: 1 };
};

describe('stopParts', () => {
  it('stops each part with its own limit, in parallel', async () => {
    const f = fake(() => ({}));
    const p = parts(f);
    const res = await p.stopParts(['worker-files', 'worker-identify']);
    expect(res).toEqual({ done: ['worker-files', 'worker-identify'], stuck: [] });
    expect(f.calls).toEqual([
      ['compose', 'stop', '-t', '30', 'worker-files'],
      ['compose', 'stop', '-t', '30', 'worker-identify'],
    ]);
    expect(f.calls.some((c) => c[0] === 'kill')).toBe(false);
    expect(p.stuckSince('worker-files')).toBeNull();
  });

  it('gives each call its limit', async () => {
    const limits: Array<[string, number | undefined]> = [];
    const f = fake(stuckStop);
    const p = new Parts({
      docker: (args, opts) => { limits.push([args.slice(0, 2).join(' '), opts?.timeoutMs]); return f.docker(args, opts); },
      music: null,
      now: () => f.state.clock,
      log: () => {},
    });
    await p.stopParts(['worker-identify']);
    expect(limits).toEqual([
      ['compose stop', PART_LIMITS.stopMs],
      ['compose ps', PART_LIMITS.psMs],
      [`inspect --format`, PART_LIMITS.inspectMs],
      [`kill ${id('worker-identify')}`, PART_LIMITS.killMs],
      [`inspect --format`, PART_LIMITS.inspectMs],
    ]);
  });

  it('kills a part that does not stop, once', async () => {
    let killed = false;
    const f = fake((a) => {
      if (isStop(a)) return 'timeout';
      if (isPs(a)) return { stdout: 'worker-files-c1\n' };
      if (a[0] === 'inspect') return { stdout: killed ? 'exited\n' : 'running\n' };
      if (a[0] === 'kill') { killed = true; return {}; }
      return { code: 1 };
    });
    const lines: string[] = [];
    const res = await parts(f, null, lines).stopParts(['worker-files']);
    expect(res).toEqual({ done: ['worker-files'], stuck: [] });
    expect(f.calls.filter((c) => c[0] === 'kill')).toEqual([['kill', 'worker-files-c1']]);
    expect(f.calls.filter((c) => c[0] === 'inspect')).toEqual([
      ['inspect', '--format', '{{.State.Status}}', 'worker-files-c1'],
      ['inspect', '--format', '{{.State.Status}}', 'worker-files-c1'],
    ]);
    expect(lines).toContain('the file worker did not stop within 60 s; stopping it by force');
  });

  it('a part whose stop fails but that is already exited is stopped, without a kill', async () => {
    const f = fake((a) => (isStop(a) ? { code: 1 } : isPs(a) ? { stdout: 'worker-files-c1\n' } : a[0] === 'inspect' ? { stdout: 'exited\n' } : { code: 1 }));
    expect(await parts(f).stopParts(['worker-files'])).toEqual({ done: ['worker-files'], stuck: [] });
    expect(f.calls.some((c) => c[0] === 'kill')).toBe(false);
  });

  it('a part with no container is stopped', async () => {
    const f = fake((a) => (isStop(a) ? 'timeout' : isPs(a) ? { stdout: '' } : { code: 1 }));
    expect(await parts(f).stopParts(['worker-files'])).toEqual({ done: ['worker-files'], stuck: [] });
    expect(f.calls.some((c) => c[0] === 'inspect' || c[0] === 'kill')).toBe(false);
  });

  it('names a silent share when a music part cannot be stopped', async () => {
    const f = fake(stuckStop);
    const start = f.state.clock;
    const { music, reads } = prober({ verdict: 'music_unreachable', server: '192.0.2.10' });
    const p = parts(f, music);
    const res = await p.stopParts(['worker-files']);
    expect(res.stuck).toEqual([{ service: 'worker-files', cause: 'music_unreachable', server: '192.0.2.10' }]);
    expect(res.done).toEqual([]);
    expect(reads).toEqual([[{ service: 'worker-files', stuck: true }]]);
    expect(f.state.clock).toBeLessThanOrEqual(start + 150_000);
    expect(p.stuckSince('worker-files')).toEqual({ kind: 'stop', at: start });
  });

  it('a part that is not music-bound is stuck_stop, without a probe', async () => {
    const f = fake(stuckStop);
    const { music, reads } = prober({ verdict: 'music_unreachable', server: '192.0.2.10' });
    const res = await parts(f, music).stopParts(['worker-identify']);
    expect(res).toEqual({ done: [], stuck: [{ service: 'worker-identify', cause: 'stuck_stop', server: null }] });
    expect(reads).toEqual([]);
  });

  it('a null reading still ends in stuck_stop within the limits', async () => {
    const f = fake(stuckStop);
    const start = f.state.clock;
    const res = await parts(f, prober(null).music).stopParts(['worker-files']);
    expect(res).toEqual({ done: [], stuck: [{ service: 'worker-files', cause: 'stuck_stop', server: null }] });
    expect(f.state.clock).toBeLessThanOrEqual(start + 150_000);
  });

  it('a reading that is ok is stuck_stop', async () => {
    const f = fake(stuckStop);
    const res = await parts(f, prober({ verdict: 'ok', server: '192.0.2.10' }).music).stopParts(['worker-files']);
    expect(res.stuck).toEqual([{ service: 'worker-files', cause: 'stuck_stop', server: null }]);
  });

  it('never sends the same stop or kill twice within a minute', async () => {
    // Stop and kill fail at once, so the second round comes well within the gap.
    const f = fake((a) => (isStop(a) || a[0] === 'kill' ? { code: 1 } : isPs(a) ? { stdout: 'worker-files-c1\n' } : a[0] === 'inspect' ? { stdout: 'running\n' } : { code: 1 }));
    const p = parts(f);
    await p.stopParts(['worker-files']);
    const res = await p.stopParts(['worker-files']);
    expect(res.stuck).toEqual([{ service: 'worker-files', cause: 'stuck_stop', server: null }]);
    expect(f.calls.filter(isStop)).toHaveLength(1);
    expect(f.calls.filter((c) => c[0] === 'kill')).toHaveLength(1);
  });

  it('sends them again once the gap is over', async () => {
    const f = fake((a) => (isStop(a) || a[0] === 'kill' ? { code: 1 } : isPs(a) ? { stdout: 'worker-files-c1\n' } : a[0] === 'inspect' ? { stdout: 'running\n' } : { code: 1 }));
    const p = parts(f);
    await p.stopParts(['worker-files']);
    f.state.clock += PART_LIMITS.resendGapMs;
    await p.stopParts(['worker-files']);
    expect(f.calls.filter(isStop)).toHaveLength(2);
    expect(f.calls.filter((c) => c[0] === 'kill')).toHaveLength(2);
  });

  it('a part started again is stopped gently again, even within the gap', async () => {
    const f = fake((a) => (isStop(a) ? { code: 1 } : isPs(a) ? { stdout: 'worker-files-c1\n' } : a[0] === 'inspect' ? { stdout: 'exited\n' } : {}));
    const p = parts(f);
    await p.stopParts(['worker-files']);
    await p.startParts(['worker-files']);
    await p.stopParts(['worker-files']);
    expect(f.calls.filter(isStop)).toHaveLength(2);
  });

  it('never throws: a runner that rejects is a failed call', async () => {
    const f = fake(() => 'reject');
    const res = await parts(f).stopParts(['worker-files']);
    expect(res).toEqual({ done: [], stuck: [{ service: 'worker-files', cause: 'stuck_stop', server: null }] });
  });
});

describe('startParts', () => {
  it('starts music parts last, one at a time, and keeps going past a stuck one', async () => {
    let inFlight = 0;
    let most = 0;
    const f = fake((a) => {
      if (isUp(a)) return a.at(-1) === 'worker-files' ? 'timeout' : {};
      if (isPs(a)) return { stdout: `${id(a.at(-1)!)}\n` };
      if (a[0] === 'inspect') return { stdout: a.at(-1) === id('worker-files') ? 'created\n' : 'running\n' };
      return { code: 1 };
    });
    const p = new Parts({
      docker: async (args, opts) => { inFlight++; most = Math.max(most, inFlight); try { return await f.docker(args, opts); } finally { inFlight--; } },
      music: null,
      now: () => f.state.clock,
      log: () => {},
    });
    const start = f.state.clock;
    const res = await p.startParts(['player', 'worker-files', 'worker-identify', 'postgres']);
    const ups = f.calls.filter(isUp).map((c) => c.at(-1));
    expect(ups).toEqual(['postgres', 'worker-identify', 'worker-files', 'player']);
    expect(res).toEqual({ done: ['postgres', 'worker-identify', 'player'], stuck: [{ service: 'worker-files', cause: 'stuck_start', server: null }] });
    expect(most).toBe(1);
    expect(f.calls.filter(isUp)[0]).toEqual(['compose', 'up', '-d', '--no-deps', 'postgres']);
    expect(p.stuckSince('worker-files')).toEqual({ kind: 'start', at: start });
    expect(p.stuckSince('player')).toBeNull();
  });

  it('names a silent share when a music part cannot start', async () => {
    const f = fake((a) => (isUp(a) ? 'timeout' : isPs(a) ? { stdout: 'worker-files-c1\n' } : a[0] === 'inspect' ? { stdout: 'created\n' } : { code: 1 }));
    const res = await parts(f, prober({ verdict: 'music_unreachable', server: '192.0.2.10' }).music).startParts(['worker-files']);
    expect(res.stuck).toEqual([{ service: 'worker-files', cause: 'music_unreachable', server: '192.0.2.10' }]);
  });

  it('a part that is removing is stuck', async () => {
    const f = fake((a) => (isPs(a) ? { stdout: 'worker-identify-c1\n' } : a[0] === 'inspect' ? { stdout: 'removing\n' } : {}));
    expect((await parts(f).startParts(['worker-identify'])).stuck).toEqual([{ service: 'worker-identify', cause: 'stuck_start', server: null }]);
  });

  it('a part that restarts counts as started', async () => {
    const f = fake((a) => (isPs(a) ? { stdout: 'worker-identify-c1\n' } : a[0] === 'inspect' ? { stdout: 'restarting\n' } : {}));
    expect(await parts(f).startParts(['worker-identify'])).toEqual({ done: ['worker-identify'], stuck: [] });
  });

  it('passes --force-recreate when asked', async () => {
    const f = fake((a) => (isPs(a) ? { stdout: 'app-c1\n' } : a[0] === 'inspect' ? { stdout: 'running\n' } : {}));
    await parts(f).startParts(['app'], { forceRecreate: true });
    expect(f.calls.filter(isUp)).toEqual([['compose', 'up', '-d', '--no-deps', '--force-recreate', 'app']]);
  });

  it('skips the parts it is told to', async () => {
    const f = fake((a) => (isPs(a) ? { stdout: `${id(a.at(-1)!)}\n` } : a[0] === 'inspect' ? { stdout: 'running\n' } : {}));
    const res = await parts(f).startParts(['worker-files', 'worker-identify'], { skip: ['worker-files'] });
    expect(f.calls.filter(isUp).map((c) => c.at(-1))).toEqual(['worker-identify']);
    expect(f.calls.some((c) => c.includes('worker-files'))).toBe(false);
    expect(res).toEqual({ done: ['worker-identify'], stuck: [] });
  });

  it('never throws: a runner that rejects is a failed call', async () => {
    const f = fake(() => 'reject');
    await expect(parts(f).startParts(['worker-identify'])).resolves.toEqual({ done: [], stuck: [] });
  });
});

describe('the commands', () => {
  it('only ever runs stop, kill, up, ps and inspect', async () => {
    const all: string[][] = [];
    for (const script of [stuckStop, () => ({}), (a: string[]): Answer => (isUp(a) ? 'timeout' : stuckStop(a))]) {
      const f = fake(script);
      const p = parts(f, prober({ verdict: 'music_unreachable', server: '192.0.2.10' }).music);
      await p.stopParts(['worker-files', 'worker-identify', 'player']);
      await p.startParts(['worker-files', 'worker-identify', 'postgres'], { forceRecreate: true });
      all.push(...f.calls);
    }
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) expect(['compose stop', 'compose up', 'compose ps', 'kill', 'inspect'].some((p) => c.join(' ').startsWith(p))).toBe(true);
  });

  it('puts the compose prefix in front of every compose call', async () => {
    const f = fake((a) => (a[0] === 'compose' && a[3] === 'stop' ? 'timeout' : a[3] === 'ps' ? { stdout: 'c1\n' } : a[0] === 'inspect' ? { stdout: 'exited\n' } : {}));
    const p = new Parts({ docker: f.docker, music: null, now: () => f.state.clock, log: () => {}, compose: (args) => ['compose', '-p', 'robin', ...args.slice(1)] });
    await p.stopParts(['worker-files']);
    expect(f.calls[0]).toEqual(['compose', '-p', 'robin', 'stop', '-t', '30', 'worker-files']);
    expect(f.calls[1]).toEqual(['compose', '-p', 'robin', 'ps', '-a', '-q', 'worker-files']);
  });
});
