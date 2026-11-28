import { describe, expect, it } from 'vitest';
import { newRun } from './update.js';
import { SELF_REPLACE_STALE_MS, SelfReplaceGate, isStale, parseState, refusalMessage, serializeState, type SelfReplaceMarker } from './self-replace.js';

const T0 = Date.parse('2026-10-16T10:00:00Z');

function gate(version: string, clock = { now: T0 }) {
  const logs: Array<{ level: string; message: string }> = [];
  let writes = 0;
  const g = new SelfReplaceGate({
    version,
    persist: async () => { writes += 1; },
    now: () => new Date(clock.now),
    log: (level, message) => { logs.push({ level, message }); },
  });
  return { g, logs, clock, writes: () => writes };
}

const marker = (over: Partial<SelfReplaceMarker> = {}): SelfReplaceMarker => ({
  expectedVersion: '0.9.0',
  fromVersion: '0.8.0',
  runId: 'run-1',
  since: new Date(T0).toISOString(),
  ...over,
});

describe('self-replace gate', () => {
  it('accepts runs while no hand-over is pending', async () => {
    const { g } = gate('0.8.0');
    expect(await g.refusal()).toBeNull();
    expect(g.current).toBeNull();
  });

  it('refuses from the moment the hand-over begins, and says which version it waits for', async () => {
    const { g, writes } = gate('0.8.0');
    await g.begin('0.9.0', 'run-1');
    expect(writes()).toBe(1);
    expect(g.current).toEqual(marker());
    expect(await g.refusal()).toBe('the updater is restarting itself on version 0.9.0; try again in a minute');
  });

  it('accepts runs again when the hand-over fails, with a warning', async () => {
    const { g, logs, writes } = gate('0.8.0');
    await g.begin('0.9.0', 'run-1');
    await g.abort('the one-off container did not start');
    expect(await g.refusal()).toBeNull();
    expect(writes()).toBe(2);
    expect(logs).toEqual([{ level: 'warn', message: 'the one-off container did not start; still on 0.8.0' }]);
  });

  it('stops refusing once the marker is older than the stale limit, and logs it', async () => {
    const { g, logs, clock } = gate('0.8.0');
    await g.begin('0.9.0', 'run-1');
    clock.now = T0 + SELF_REPLACE_STALE_MS;
    expect(await g.refusal()).not.toBeNull();
    clock.now = T0 + SELF_REPLACE_STALE_MS + 1;
    expect(await g.refusal()).toBeNull();
    expect(g.current).toBeNull();
    expect(logs.at(-1)).toMatchObject({ level: 'warn', message: expect.stringContaining('did not happen within 10 min') });
  });

  it('a new updater on the expected version clears the marker quietly', async () => {
    const { g, logs, writes } = gate('0.9.0');
    await g.adopt(marker());
    expect(g.current).toBeNull();
    expect(await g.refusal()).toBeNull();
    expect(writes()).toBe(1);
    expect(logs).toEqual([{ level: 'info', message: 'the updater restarted on 0.9.0 as planned' }]);
  });

  describe('a finished hand-over', () => {
    function noting(version: string, over: Partial<ConstructorParameters<typeof SelfReplaceGate>[0]> = {}, clock = { now: T0 }) {
      const events: string[] = [];
      const g = new SelfReplaceGate({
        version,
        persist: async () => { events.push('persist'); },
        handedOver: async (v) => { events.push(`handedOver ${v}`); },
        now: () => new Date(clock.now),
        log: () => {},
        ...over,
      });
      return { g, events };
    }

    it('the replacement on the expected version says so, and notes it before the marker is cleared', async () => {
      const { g, events } = noting('0.9.0');
      expect(await g.adopt(marker())).toBe(true);
      expect(events).toEqual(['handedOver 0.9.0', 'persist']);
    });

    it('recognises the marker the 0.38 updater writes', async () => {
      const { g, events } = noting('0.39.0');
      const written = serializeState(newRun('run-38', '0.38.0', '0.39.0', new Date(T0)), { expectedVersion: '0.39.0', fromVersion: '0.38.0', runId: 'run-38', since: new Date(T0).toISOString() });
      expect(await g.adopt(parseState(written).marker)).toBe(true);
      expect(events[0]).toBe('handedOver 0.39.0');
    });

    it('no hand-over: no marker, another version, a stale marker, the old updater waiting', async () => {
      for (const [version, found, now] of [
        ['0.9.0', null, T0],
        ['0.8.1', marker(), T0],
        ['0.9.0', marker(), T0 + SELF_REPLACE_STALE_MS + 1],
      ] as const) {
        const { g, events } = noting(version, {}, { now });
        expect(await g.adopt(found)).toBe(false);
        expect(events.filter((e) => e.startsWith('handedOver'))).toEqual([]);
      }
      const { g, events } = noting('0.8.0', { handoverRunning: async () => true });
      expect(await g.adopt(marker())).toBe(false);
      expect(events).toEqual([]);
    });

    it('a failed note still clears the marker', async () => {
      const { g, events } = noting('0.9.0', { handedOver: async () => { throw new Error('EROFS'); } });
      expect(await g.adopt(marker())).toBe(true);
      expect(g.current).toBeNull();
      expect(events).toEqual(['persist']);
    });
  });

  it('a new updater on another version clears the marker with a warning', async () => {
    const { g, logs } = gate('0.8.1');
    await g.adopt(marker());
    expect(await g.refusal()).toBeNull();
    expect(logs).toEqual([{ level: 'warn', message: expect.stringContaining('was to restart on 0.9.0 but runs 0.8.1') }]);
  });

  it('a stale marker found on start is cleared with a warning', async () => {
    const { g, logs } = gate('0.8.0', { now: T0 + SELF_REPLACE_STALE_MS + 60_000 });
    await g.adopt(marker());
    expect(await g.refusal()).toBeNull();
    expect(logs).toEqual([{ level: 'warn', message: expect.stringContaining('never finished') }]);
  });

  describe('the old updater restarted by Docker before it was replaced', () => {
    function restarted(running: Array<boolean | null>, clock = { now: T0 + 60_000 }) {
      const logs: string[] = [];
      let writes = 0;
      const g = new SelfReplaceGate({
        version: '0.8.0',
        persist: async () => { writes += 1; },
        now: () => new Date(clock.now),
        log: (level, m) => { logs.push(`${level}: ${m}`); },
        handoverRunning: async () => (running.length > 1 ? running.shift()! : running[0]!),
      });
      return { g, logs, clock, writes: () => writes };
    }

    it('keeps refusing while the hand-over container runs, and reopens once it is gone', async () => {
      const { g, logs, writes } = restarted([true, true, false]);
      await g.adopt(marker());
      expect(g.current).toEqual(marker());
      expect(writes()).toBe(0);
      expect(logs[0]).toMatch(/^warn: restarted on 0\.8\.0 while the hand-over to 0\.9\.0 still runs; refusing/);
      expect(await g.refusal()).toMatch(/restarting itself on version 0\.9\.0/);
      expect(await g.refusal()).toBeNull();
      expect(logs.at(-1)).toMatch(/is gone without replacing this updater/);
      expect(writes()).toBe(1);
    });

    it('keeps refusing when Docker cannot say, until the marker is stale', async () => {
      const { g, clock } = restarted([null]);
      await g.adopt(marker());
      expect(await g.refusal()).not.toBeNull();
      clock.now = T0 + SELF_REPLACE_STALE_MS + 1;
      expect(await g.refusal()).toBeNull();
    });

    it('clears at once when no hand-over container runs', async () => {
      const { g, logs } = restarted([false]);
      await g.adopt(marker());
      expect(g.current).toBeNull();
      expect(logs[0]).toMatch(/ended without replacing this updater/);
    });

    it('clears a stale marker without asking Docker', async () => {
      const { g } = restarted([true], { now: T0 + SELF_REPLACE_STALE_MS + 1 });
      await g.adopt(marker());
      expect(g.current).toBeNull();
    });
  });

  it('reports the marker with its age by its own clock', async () => {
    const { g, clock } = gate('0.8.0');
    await g.begin('0.9.0', 'run-1');
    clock.now = T0 + 42_000;
    expect(await g.status()).toEqual({ ...marker(), ageMs: 42_000 });
    await g.abort('x');
    expect(await g.status()).toBeNull();
  });

  it('no marker on start: nothing to write', async () => {
    const { g, writes, logs } = gate('0.9.0');
    await g.adopt(null);
    expect(writes()).toBe(0);
    expect(logs).toEqual([]);
  });

  it('keeps gating in memory when state.json cannot be written', async () => {
    const logs: string[] = [];
    const g = new SelfReplaceGate({ version: '0.8.0', persist: async () => { throw new Error('EROFS'); }, log: (_l, m) => { logs.push(m); } });
    await g.begin('0.9.0', 'run-1');
    expect(await g.refusal()).toMatch(/restarting itself on version 0\.9\.0/);
    expect(logs[0]).toMatch(/could not write the restart marker.*EROFS/);
  });
});

describe('isStale', () => {
  it('treats an unreadable or far-future time as stale', () => {
    const now = new Date(T0);
    expect(isStale(marker(), now)).toBe(false);
    expect(isStale(marker({ since: 'yesterday-ish' }), now)).toBe(true);
    expect(isStale(marker({ since: new Date(T0 + 3_600_000).toISOString() }), now)).toBe(true);
  });
});

describe('state.json with a marker', () => {
  it('round-trips the run and the marker, and reads files without one', () => {
    const run = newRun('run-1', '0.8.0', '0.9.0', new Date(T0));
    const withMarker = serializeState(run, marker());
    expect(parseState(withMarker)).toEqual({ run, marker: marker() });
    expect(JSON.parse(withMarker).id).toBe('run-1');
    // an older updater wrote only the run
    expect(parseState(JSON.stringify(run))).toEqual({ run, marker: null });
    expect(parseState(serializeState(run, null))).toEqual({ run, marker: null });
    expect(parseState('null')).toEqual({ run: null, marker: null });
  });

  it('ignores a malformed marker', () => {
    const run = newRun('run-1', '0.8.0', '0.9.0', new Date(T0));
    expect(parseState(JSON.stringify({ ...run, selfReplace: { expectedVersion: 9 } })).marker).toBeNull();
  });

  it('refusal message names the version', () => {
    expect(refusalMessage(marker({ expectedVersion: '1.0.0' }))).toBe('the updater is restarting itself on version 1.0.0; try again in a minute');
  });
});
