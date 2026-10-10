/**
 * The shared job stream across "tabs": each tab is a fresh copy of the
 * module (vi.resetModules) sharing one fake localStorage and one fake
 * BroadcastChannel bus, as tabs of one origin share them in a browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('./jobStream');

class FakeEventSource {
  static all: FakeEventSource[] = [];
  closed = false;
  private handlers = new Map<string, Array<(e: { data: string }) => void>>();
  constructor(public url: string) { FakeEventSource.all.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
  emit(type: string, data: unknown) {
    for (const fn of this.handlers.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
  static open() { return FakeEventSource.all.filter((s) => !s.closed); }
}

class FakeBroadcastChannel {
  static bus = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(public name: string) {
    const peers = FakeBroadcastChannel.bus.get(name) ?? new Set();
    peers.add(this);
    FakeBroadcastChannel.bus.set(name, peers);
  }
  postMessage(data: unknown) {
    for (const peer of FakeBroadcastChannel.bus.get(this.name) ?? []) {
      if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data: structuredClone(data) }));
    }
  }
  close() { FakeBroadcastChannel.bus.get(this.name)?.delete(this); }
}

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

async function openTab(): Promise<Mod> {
  vi.resetModules();
  return import('./jobStream');
}

const LIB = 'lib-1';

describe('shared job stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.all = [];
    FakeBroadcastChannel.bus.clear();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('localStorage', fakeStorage());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens one EventSource for seven tabs and delivers its events to all of them', async () => {
    const received: string[][] = [];
    const tabs: Mod[] = [];
    for (let i = 0; i < 7; i++) {
      const tab = await openTab();
      const got: string[] = [];
      received.push(got);
      tab.subscribeJobEvents(LIB, (type, data) => got.push(`${type}:${JSON.parse(data).n}`));
      tabs.push(tab);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(FakeEventSource.open()).toHaveLength(1);
    expect(tabs.filter((t) => t.isJobStreamLeader(LIB))).toHaveLength(1);

    FakeEventSource.open()[0]!.emit('job.progress', { libraryId: LIB, n: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(received.every((got) => got.join() === 'job.progress:1')).toBe(true);
  });

  it('hands the stream to another tab when the leader leaves', async () => {
    const a = await openTab();
    const unsubA = a.subscribeJobEvents(LIB, () => undefined);
    await vi.advanceTimersByTimeAsync(300);
    const b = await openTab();
    const got: string[] = [];
    b.subscribeJobEvents(LIB, (type) => got.push(type));
    await vi.advanceTimersByTimeAsync(300);
    expect(a.isJobStreamLeader(LIB)).toBe(true);
    expect(b.isJobStreamLeader(LIB)).toBe(false);

    unsubA(); // the leader's tab closes (pagehide releases the same way)
    await vi.advanceTimersByTimeAsync(300);
    expect(b.isJobStreamLeader(LIB)).toBe(true);
    expect(FakeEventSource.open()).toHaveLength(1);
    FakeEventSource.open()[0]!.emit('queue.changed', { libraryId: LIB });
    expect(got).toEqual(['queue.changed']);
  });

  it('takes over after the lease runs out when the leader dies without a word', async () => {
    const leaseKey = `tagave:job-stream-leader:${LIB}`;
    // a tab that crashed while leading: its lease is still in storage, it
    // never sent "released" and will never renew
    globalThis.localStorage.setItem(leaseKey, JSON.stringify({ id: 'dead-tab', expires: Date.now() + 30_000 }));
    const b = await openTab();
    b.subscribeJobEvents(LIB, () => undefined);
    await vi.advanceTimersByTimeAsync(b.RENEW_MS * 2);
    expect(b.isJobStreamLeader(LIB)).toBe(false); // the lease is still valid
    expect(FakeEventSource.open()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(b.LEASE_MS);
    expect(b.isJobStreamLeader(LIB)).toBe(true);
    expect(FakeEventSource.open()).toHaveLength(1);
  });

  it('falls back to a stream per tab without BroadcastChannel', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const a = await openTab();
    a.subscribeJobEvents(LIB, () => undefined);
    const b = await openTab();
    b.subscribeJobEvents(LIB, () => undefined);
    expect(FakeEventSource.open()).toHaveLength(2);
  });
});
