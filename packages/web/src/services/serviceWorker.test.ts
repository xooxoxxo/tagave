/**
 * The service worker (sw/sw.js) run in a fake worker scope: what it answers,
 * what it leaves to the network, and how a new version drops the old cache.
 * Also registerServiceWorker.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './serviceWorker';

const ORIGIN = 'https://tagave.test';
const SOURCE = readFileSync(resolve(import.meta.dirname, '../../sw/sw.js'), 'utf8');

type Listener = (event: unknown) => void;

interface FakeRequest { url: string; method: string; mode: string; headers: Headers }

function req(path: string, init: { mode?: string; method?: string; headers?: Record<string, string> } = {}): FakeRequest {
  return { url: new URL(path, ORIGIN).href, method: init.method ?? 'GET', mode: init.mode ?? 'cors', headers: new Headers(init.headers ?? {}) };
}

const keyOf = (r: FakeRequest | string) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).href;

function html(body: string, status = 200) {
  const r = new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  Object.defineProperty(r, 'type', { value: 'basic' });
  return r;
}
function js(body: string, status = 200) {
  const r = new Response(body, { status, headers: { 'content-type': 'text/javascript' } });
  Object.defineProperty(r, 'type', { value: 'basic' });
  return r;
}

/** A worker scope with Map-backed caches; `version` and `precache` are what the build writes in front. */
function boot({ version = 'v1', precache = ['/assets/index-a.js'], stores = new Map<string, Map<string, Response>>() } = {}) {
  const listeners = new Map<string, Listener>();
  const fetch = vi.fn<(r: FakeRequest | Request | string) => Promise<Response>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      put: async (r: FakeRequest | string, res: Response) => { store.set(keyOf(r), res); },
      add: async (r: Request | string) => {
        const res = await fetch(r as Request);
        if (!res.ok) throw new TypeError('bad status');
        store.set(keyOf(typeof r === 'string' ? r : r.url), res);
      },
    };
  };
  const caches = {
    open,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (r: FakeRequest | string, opts: { cacheName?: string } = {}) => {
      const res = opts.cacheName ? stores.get(opts.cacheName)?.get(keyOf(r)) : undefined;
      return res ? res.clone() : undefined;
    },
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  const head = `const SW_VERSION = ${JSON.stringify(version)};\nconst SW_PRECACHE = ${JSON.stringify(precache)};\n`;
  // a worker resolves relative URLs against its own location
  const WorkerRequest = function (input: string, init?: RequestInit) { return new Request(new URL(input, ORIGIN), init); };
  new Function('self', 'caches', 'fetch', 'Request', head + SOURCE)(self, caches, fetch, WorkerRequest);

  /** Dispatches a fetch event; resolves to the response, or null when the worker left it to the network. */
  async function onFetch(request: FakeRequest): Promise<Response | null> {
    let answer: Promise<Response> | null = null;
    const waits: Promise<unknown>[] = [];
    listeners.get('fetch')!({ request, respondWith: (p: Promise<Response>) => { answer = p; }, waitUntil: (p: Promise<unknown>) => { waits.push(p); } });
    if (!answer) return null;
    const res = await (answer as Promise<Response>);
    await Promise.all(waits);
    return res;
  }
  async function lifecycle(type: 'install' | 'activate') {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => { waits.push(p); } });
    await Promise.all(waits);
  }
  return { fetch, stores, self, onFetch, lifecycle };
}

describe('service worker', () => {
  it('loads a page from the network first and keeps the copy for when the network fails', async () => {
    const sw = boot();
    sw.fetch.mockResolvedValueOnce(html('<p>new build</p>'));
    const first = await sw.onFetch(req('/albums/abc', { mode: 'navigate' }));
    expect(await first!.text()).toBe('<p>new build</p>');
    expect(sw.fetch).toHaveBeenCalledTimes(1);

    sw.fetch.mockRejectedValueOnce(new TypeError('offline'));
    const offline = await sw.onFetch(req('/queue', { mode: 'navigate' }));
    expect(await offline!.text()).toBe('<p>new build</p>');
  });

  it('a page load always asks the network, even with a copy kept (a reload after an update gets the new build)', async () => {
    const sw = boot();
    sw.fetch.mockResolvedValueOnce(html('old')).mockResolvedValueOnce(html('new'));
    await sw.onFetch(req('/', { mode: 'navigate' }));
    const res = await sw.onFetch(req('/', { mode: 'navigate' }));
    expect(await res!.text()).toBe('new');
    expect(sw.fetch).toHaveBeenCalledTimes(2);
  });

  it('passes an error page through and does not keep it', async () => {
    const sw = boot();
    sw.fetch.mockResolvedValueOnce(html('good')).mockResolvedValueOnce(html('bad gateway', 502));
    await sw.onFetch(req('/', { mode: 'navigate' }));
    const res = await sw.onFetch(req('/', { mode: 'navigate' }));
    expect(res!.status).toBe(502);
    sw.fetch.mockRejectedValueOnce(new TypeError('offline'));
    expect(await (await sw.onFetch(req('/', { mode: 'navigate' })))!.text()).toBe('good');
  });

  it('with nothing kept, a failed page load fails as it would without a worker', async () => {
    const sw = boot();
    sw.fetch.mockRejectedValueOnce(new TypeError('offline'));
    await expect(sw.onFetch(req('/', { mode: 'navigate' }))).rejects.toThrow('offline');
  });

  it.each([
    ['/api/auth/callback/x', 'navigate'],
    ['/api/v1/player/stream/t1?format=original', 'no-cors'],
    ['/api/v1/me', 'cors'],
    ['/mc/feed', 'navigate'],
    ['/.well-known/openid-configuration', 'navigate'],
    ['/manifest.webmanifest', 'cors'],
    ['/tagave-mark.svg', 'no-cors'],
  ])('leaves %s (%s) to the network', async (path, mode) => {
    const sw = boot();
    expect(await sw.onFetch(req(path, { mode }))).toBeNull();
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it('leaves other origins, non-GET requests and ranged asset requests to the network', async () => {
    const sw = boot();
    expect(await sw.onFetch({ ...req('/'), url: 'https://cdn.example/x.js' })).toBeNull();
    expect(await sw.onFetch(req('/login', { mode: 'navigate', method: 'POST' }))).toBeNull();
    expect(await sw.onFetch(req('/assets/a.js', { headers: { range: 'bytes=0-1' } }))).toBeNull();
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it('serves /assets/ from the cache once fetched; a failed one is not kept', async () => {
    const sw = boot();
    sw.fetch.mockResolvedValueOnce(js('chunk'));
    expect(await (await sw.onFetch(req('/assets/Page-x.js')))!.text()).toBe('chunk');
    expect(await (await sw.onFetch(req('/assets/Page-x.js')))!.text()).toBe('chunk');
    expect(sw.fetch).toHaveBeenCalledTimes(1);

    sw.fetch.mockResolvedValueOnce(js('gone', 404)).mockResolvedValueOnce(js('gone', 404));
    expect((await sw.onFetch(req('/assets/Old-y.js')))!.status).toBe(404);
    expect((await sw.onFetch(req('/assets/Old-y.js')))!.status).toBe(404);
    expect(sw.fetch).toHaveBeenCalledTimes(3);
  });

  it('install keeps the shell and the entry files, then takes over at once', async () => {
    const sw = boot({ precache: ['/assets/index-a.js', '/assets/missing.js'] });
    sw.fetch.mockImplementation(async (r) => {
      const url = typeof r === 'string' ? r : r.url;
      if (url.endsWith('/missing.js')) return js('', 404);
      return url.endsWith('.js') ? js('entry') : html('shell');
    });
    await sw.lifecycle('install');
    const store = sw.stores.get('tagave-shell-v1')!;
    expect([...store.keys()].sort()).toEqual([`${ORIGIN}/`, `${ORIGIN}/assets/index-a.js`]);
    expect(sw.self.skipWaiting).toHaveBeenCalled();
  });

  it('a new version drops the old version\'s cache and nothing else', async () => {
    const stores = new Map<string, Map<string, Response>>([
      ['tagave-shell-v1', new Map()],
      ['tagave-shell-v2', new Map()],
      ['someone-else', new Map()],
    ]);
    const sw = boot({ version: 'v2', stores });
    await sw.lifecycle('activate');
    expect([...stores.keys()].sort()).toEqual(['someone-else', 'tagave-shell-v2']);
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });
});

describe('registerServiceWorker', () => {
  it('registers /sw.js at the root in a built bundle, once the page has loaded', () => {
    const register = vi.fn(async () => ({}) as ServiceWorkerRegistration);
    const container = { register } as unknown as ServiceWorkerContainer;
    vi.stubGlobal('document', { readyState: 'complete' });
    try {
      expect(registerServiceWorker({ enabled: true, container })).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('does nothing in vite dev or without service workers (plain http on a LAN)', () => {
    const register = vi.fn();
    expect(registerServiceWorker({ enabled: false, container: { register } as unknown as ServiceWorkerContainer })).toBe(false);
    expect(registerServiceWorker({ enabled: true, container: undefined })).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });
});
