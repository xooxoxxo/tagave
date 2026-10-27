/**
 * The short-album artwork is painted only when its size, ink or title change,
 * in a worker when the browser can hand the canvas over, and the worker ends
 * with the canvas (freeze hunt 2026-10-11).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const drawFiller = vi.fn();
vi.mock('./albumFlow', async (orig) => ({ ...(await orig<typeof import('./albumFlow')>()), drawFiller: (...a: unknown[]) => drawFiller(...a) }));
vi.mock('./AlbumDetailPage.module.css', () => ({ default: {} }));

class FakeWorker {
  static all: FakeWorker[] = [];
  messages: Array<Record<string, unknown>> = [];
  terminated = false;
  constructor(public url: URL | string) { FakeWorker.all.push(this); }
  postMessage(m: Record<string, unknown>) { this.messages.push(m); }
  terminate() { this.terminated = true; }
}

let resize: Array<() => void> = [];
const ink = { value: '#276a82' };

function canvas(over: Record<string, unknown> = {}) {
  return { clientWidth: 600, clientHeight: 400, isConnected: true, ...over } as unknown as HTMLCanvasElement;
}

beforeEach(() => {
  drawFiller.mockReset();
  FakeWorker.all = [];
  resize = [];
  vi.useFakeTimers();
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => ink.value }));
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resize.push(cb); } observe() {} disconnect() {} });
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('devicePixelRatio', 2);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('short-album artwork', () => {
  it('paints on the page once per size, ink and title', async () => {
    const { attachFiller } = await import('./AlbumFiller');
    const cv = canvas();
    const painted = { current: '' };
    let detach = attachFiller(cv, 'Shock Me', painted);
    expect(drawFiller).toHaveBeenCalledTimes(1);
    resize.forEach((cb) => cb()); // the observer's first call, nothing changed
    detach();
    detach = attachFiller(cv, 'Shock Me', painted); // a re-render with the same box
    expect(drawFiller).toHaveBeenCalledTimes(1);
    (cv as unknown as { clientHeight: number }).clientHeight = 520;
    resize.forEach((cb) => cb());
    expect(drawFiller).toHaveBeenCalledTimes(2);
    ink.value = '#9ad0e0'; // dark theme
    resize.forEach((cb) => cb());
    expect(drawFiller).toHaveBeenCalledTimes(3);
    ink.value = '#276a82';
    detach();
  });

  it('shows and paints nothing in less room than the piece needs, and paints once there is room', async () => {
    const { attachFiller } = await import('./AlbumFiller');
    const thin = vi.fn();
    const cv = canvas({ clientHeight: 119, toggleAttribute: thin });
    const detach = attachFiller(cv, 'Shock Me', { current: '' });
    expect(drawFiller).not.toHaveBeenCalled();
    expect(thin).toHaveBeenLastCalledWith('data-thin', true);
    (cv as unknown as { clientHeight: number }).clientHeight = 120;
    resize.forEach((cb) => cb());
    expect(drawFiller).toHaveBeenCalledTimes(1);
    expect(thin).toHaveBeenLastCalledWith('data-thin', false);
    detach();
  });

  it('hands the canvas to a worker and never paints it on the page', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { attachFiller } = await import('./AlbumFiller');
    const offscreen = { offscreen: true };
    const transfer = vi.fn(() => offscreen);
    const cv = canvas({ transferControlToOffscreen: transfer });
    const painted = { current: '' };
    let detach = attachFiller(cv, 'In Absentia', painted);
    detach();
    vi.runAllTimers(); // still on the page: the worker stays
    detach = attachFiller(cv, 'In Absentia', painted);
    (cv as unknown as { clientWidth: number }).clientWidth = 700;
    resize.forEach((cb) => cb());
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(FakeWorker.all).toHaveLength(1);
    const [worker] = FakeWorker.all;
    expect(worker!.messages[0]!.canvas).toBe(offscreen);
    expect(worker!.messages.slice(1).map((m) => [m.w, m.h, m.dpr, m.title])).toEqual([[600, 400, 2, 'In Absentia'], [700, 400, 2, 'In Absentia']]);
    expect(drawFiller).not.toHaveBeenCalled();
    // the page leaves: the worker ends with it
    (cv as unknown as { isConnected: boolean }).isConnected = false;
    detach();
    vi.runAllTimers();
    expect(worker!.terminated).toBe(true);
  });
});
