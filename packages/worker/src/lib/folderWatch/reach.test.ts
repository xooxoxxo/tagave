/** Turning one probe of a music root into a reach, and readings into a status. */
import { describe, expect, it } from 'vitest';
import { classify, nextReach, type ProbeOutcome, type ReachState } from './reach.js';

const t0 = new Date('2026-11-24T14:00:00Z');
const t1 = new Date('2026-11-24T14:00:30Z');
const t2 = new Date('2026-11-24T14:01:00Z');
const t3 = new Date('2026-11-24T14:01:30Z');
const bad = { reach: 'offline', reason: 'server_silent' } as const;
const good = { reach: 'online', reason: null } as const;

describe('classify', () => {
  it.each([
    [{ kind: 'server_silent' }, 'offline', 'server_silent'],
    [{ kind: 'deadline' }, 'offline', 'timeout'],
    [{ kind: 'error', code: 'EIO' }, 'offline', 'io_error'],
    [{ kind: 'error', code: 'ESTALE' }, 'offline', 'stale'],
    [{ kind: 'error', code: 'EHOSTDOWN' }, 'offline', 'timeout'],
    [{ kind: 'listing', empty: true, knownFound: 0, knownAsked: 5, isMountPoint: false, wasMountPoint: true }, 'unmounted', 'not_mounted'],
    // Not empty and still its mount point: the sampled files are gone, the share is not. Online, so the healer is not asked.
    [{ kind: 'listing', empty: false, knownFound: 0, knownAsked: 5, isMountPoint: true, wasMountPoint: true }, 'online', null],
    [{ kind: 'listing', empty: false, knownFound: 1, knownAsked: 5, isMountPoint: true, wasMountPoint: true }, 'online', null],
  ])('%#', (o, reach, reason) => expect(classify(o as ProbeOutcome)).toEqual({ reach, reason }));

  it.each([
    [{ kind: 'error', code: 'ETIMEDOUT' }, 'offline', 'timeout'],
    // A missing root (renamed or deleted) is not a lost share: offline, never unmounted.
    [{ kind: 'error', code: 'ENOENT' }, 'offline', 'io_error'],
    // Any other error code fails safe as offline: the probe never listed anything.
    [{ kind: 'error', code: 'ENOTCONN' }, 'offline', 'io_error'],
    [{ kind: 'error', code: 'EACCES' }, 'offline', 'io_error'],
    // Keys on every object's prototype are not codes.
    [{ kind: 'error', code: 'constructor' }, 'offline', 'io_error'],
    [{ kind: 'error', code: '__proto__' }, 'offline', 'io_error'],
    [{ kind: 'error', code: 'toString' }, 'offline', 'io_error'],
    // Nothing known to ask about never reads unmounted: a new empty root, even one that lost its mount point.
    [{ kind: 'listing', empty: true, knownFound: 0, knownAsked: 0, isMountPoint: false, wasMountPoint: false }, 'online', null],
    [{ kind: 'listing', empty: true, knownFound: 0, knownAsked: 0, isMountPoint: false, wasMountPoint: true }, 'online', null],
    [{ kind: 'listing', empty: true, knownFound: 0, knownAsked: 0, isMountPoint: true, wasMountPoint: true }, 'online', null],
    [{ kind: 'listing', empty: false, knownFound: 0, knownAsked: 0, isMountPoint: false, wasMountPoint: false }, 'online', null],
    // No known file and an empty root that was never a mount point.
    [{ kind: 'listing', empty: true, knownFound: 0, knownAsked: 3, isMountPoint: false, wasMountPoint: false }, 'unmounted', 'empty'],
    // An empty mount point still mounted (an empty share): empty.
    [{ kind: 'listing', empty: true, knownFound: 0, knownAsked: 3, isMountPoint: true, wasMountPoint: true }, 'unmounted', 'empty'],
    // Not empty, no known file, never a mount point: online.
    [{ kind: 'listing', empty: false, knownFound: 0, knownAsked: 3, isMountPoint: false, wasMountPoint: false }, 'online', null],
    // Not empty, no known file, and no longer the mount point it was: the folder underneath.
    [{ kind: 'listing', empty: false, knownFound: 0, knownAsked: 3, isMountPoint: false, wasMountPoint: true }, 'unmounted', 'not_mounted'],
    // A lost mount point with known files still there reads online.
    [{ kind: 'listing', empty: false, knownFound: 2, knownAsked: 3, isMountPoint: false, wasMountPoint: true }, 'online', null],
  ])('more %#', (o, reach, reason) => expect(classify(o as ProbeOutcome)).toEqual({ reach, reason }));
});

describe('nextReach', () => {
  it('needs two bad readings to leave online, one good one to come back', () => {
    let s: ReachState = { reach: 'online', since: t0, pendingOffline: null };
    let r = nextReach(s, bad, t1); expect(r).toMatchObject({ changed: false, state: { reach: 'online', since: t0 } });
    r = nextReach(r.state, bad, t2); expect(r).toMatchObject({ changed: true, state: { reach: 'offline', since: t2 } });
    r = nextReach(r.state, bad, t2); expect(r.changed).toBe(false); expect(r.state.since).toEqual(t2);
    r = nextReach(r.state, { reach: 'online', reason: null }, t2); expect(r).toMatchObject({ changed: true, state: { reach: 'online' } });
    s = r.state;
    expect(s.pendingOffline).toBeNull();
  });

  it('a good reading between two bad ones starts the count again', () => {
    const s: ReachState = { reach: 'online', since: t0, pendingOffline: null };
    let r = nextReach(s, bad, t1);
    expect(r).toMatchObject({ changed: false, state: { reach: 'online', since: t0, pendingOffline: bad } });
    r = nextReach(r.state, good, t2);
    expect(r).toEqual({ changed: false, state: { reach: 'online', since: t0, pendingOffline: null } });
    r = nextReach(r.state, bad, t3);
    expect(r).toMatchObject({ changed: false, state: { reach: 'online', since: t0, pendingOffline: bad } });
  });

  it('unknown takes the first reading at once', () => {
    const s: ReachState = { reach: 'unknown', since: null, pendingOffline: null };
    expect(nextReach(s, bad, t1)).toEqual({ changed: true, state: { reach: 'offline', since: t1, pendingOffline: null } });
    expect(nextReach(s, good, t1)).toEqual({ changed: true, state: { reach: 'online', since: t1, pendingOffline: null } });
  });

  it('moves between offline and unmounted at once, keeping since only when the reach stays', () => {
    const s: ReachState = { reach: 'offline', since: t1, pendingOffline: null };
    const gone = { reach: 'unmounted', reason: 'not_mounted' } as const;
    expect(nextReach(s, gone, t2)).toEqual({ changed: true, state: { reach: 'unmounted', since: t2, pendingOffline: null } });
    expect(nextReach(s, { reach: 'offline', reason: 'timeout' }, t2)).toEqual({ changed: false, state: s });
  });

  it('two bad readings of different kinds take the second one', () => {
    const s: ReachState = { reach: 'online', since: t0, pendingOffline: null };
    const r = nextReach(nextReach(s, bad, t1).state, { reach: 'unmounted', reason: 'empty' }, t2);
    expect(r).toEqual({ changed: true, state: { reach: 'unmounted', since: t2, pendingOffline: null } });
  });
});
