import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

let observed: Array<(list: { getEntries: () => unknown[] }) => void> = [];
class FakeObserver {
  static supportedEntryTypes = ['longtask', 'long-animation-frame'];
  constructor(private cb: (list: { getEntries: () => unknown[] }) => void) { observed.push(cb); }
  observe() {}
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  observed = [];
  vi.stubGlobal('localStorage', fakeStorage());
  vi.stubGlobal('PerformanceObserver', FakeObserver);
  vi.stubGlobal('location', { pathname: '/albums', search: '' });
  vi.stubGlobal('document', { visibilityState: 'visible', getElementsByTagName: () => ({ length: 812 }) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('freeze diagnostics', () => {
  it('stays off unless the owner switched it on', async () => {
    const d = await import('./diagnostics');
    expect(d.startDiagnostics()).toBe(false);
    expect(observed).toHaveLength(0);
    expect((globalThis as { tagaveDiagnostics?: unknown }).tagaveDiagnostics).toBeUndefined();
  });

  it('records long frames with their attribution, keeps them across a reload and warns on freezes', async () => {
    localStorage.setItem('tagave:diagnostics', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const d = await import('./diagnostics');
    expect(d.startDiagnostics()).toBe(true);
    expect(observed).toHaveLength(1);
    observed[0]!({ getEntries: () => [
      { startTime: 1000, duration: 120, scripts: [] }, // short: not recorded
      { startTime: 2000, duration: 1500, blockingDuration: 1450, styleAndLayoutStart: 2100, scripts: [
        { invoker: 'TimerHandler:setTimeout', sourceURL: 'http://x/assets/AlbumDetailPage-abc.js', sourceCharPosition: 4210, sourceFunctionName: 'paint', duration: 90, forcedStyleAndLayoutDuration: 3 },
        { invoker: 'tiny', duration: 2 },
      ] },
    ] });
    const report = (globalThis as unknown as { tagaveDiagnostics: () => import('./diagnostics').DiagnosticsReport }).tagaveDiagnostics();
    expect(report.frames).toHaveLength(1);
    expect(report.frames[0]).toMatchObject({ page: '/albums', ms: 1500, blockingMs: 1450, styleLayoutMs: 1400, visible: true,
      scripts: [{ invoker: 'TimerHandler:setTimeout', source: 'AlbumDetailPage-abc.js:4210', fn: 'paint', ms: 90, forcedLayoutMs: 3 }] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(report.samples[0]).toMatchObject({ page: '/albums', elements: 812 });
    vi.advanceTimersByTime(30_000);
    expect((globalThis as unknown as { tagaveDiagnostics: () => { samples: unknown[] } }).tagaveDiagnostics().samples).toHaveLength(2);

    // a reload keeps the frames
    vi.resetModules();
    const again = await import('./diagnostics');
    again.startDiagnostics();
    expect((globalThis as unknown as { tagaveDiagnostics: () => { frames: unknown[] } }).tagaveDiagnostics().frames).toHaveLength(1);
  });
});
