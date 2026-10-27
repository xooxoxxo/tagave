/**
 * tagave's service worker: a fast start and an offline app shell, nothing
 * more. The build (vite.config.ts, serviceWorkerPlugin) writes it to
 * dist/sw.js with two constants in front of this file:
 *
 *   SW_VERSION  a hash of the build's file names: every build that changes a
 *               file is a new worker, and a new worker drops the old cache
 *   SW_PRECACHE the entry script, its CSS and the chunks it imports
 *
 * What it answers:
 *   - a page load (navigation) of the app: the network first, always, so a
 *     reload after an update gets the new index.html (Settings › Updates,
 *     services/buildCheck.ts, services/quietReload.ts); the cached copy only
 *     when the network fails;
 *   - /assets/*: hashed file names, so the cached copy is never stale: cache
 *     first, then the network (and kept);
 * and nothing else. /api (the music streams included), /mc, /.well-known,
 * the other root files and every non-GET request go to the network as if
 * there were no worker.
 *
 * To retire it, ship a sw.js that unregisters itself.
 */
/* global SW_VERSION, SW_PRECACHE */
const CACHE_PREFIX = 'tagave-shell-';
const CACHE = CACHE_PREFIX + SW_VERSION;
/** the key the last good index.html is kept under */
const SHELL_KEY = '/';
/** paths the server never answers with the app shell (api/src/lib/staticCache.ts servesAppShell) */
const NO_SHELL_PREFIXES = ['/api/', '/assets/', '/mc/', '/.well-known/'];

function servesAppShell(pathname) {
  const p = pathname.toLowerCase();
  return !NO_SHELL_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix));
}

/** 'shell', 'asset', or null (the network, untouched). */
function routeOf(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  if (request.mode === 'navigate') return servesAppShell(url.pathname) ? 'shell' : null;
  if (url.pathname.startsWith('/assets/') && !request.headers.has('range')) return 'asset';
  return null;
}

function isHtml(response) {
  return /^text\/html\b/i.test(response.headers.get('content-type') || '');
}

/** Keeps a copy without holding up the answer; the worker stays alive until it is written. */
function keep(event, key, response) {
  event.waitUntil(caches.open(CACHE).then((c) => c.put(key, response)).catch(() => undefined));
}

async function shell(event) {
  const request = event.request;
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic' && isHtml(response)) keep(event, SHELL_KEY, response.clone());
    return response;
  } catch (err) {
    const cached = await caches.match(SHELL_KEY, { cacheName: CACHE });
    if (cached) return cached;
    throw err;
  }
}

async function asset(event) {
  const request = event.request;
  const cached = await caches.match(request, { cacheName: CACHE });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.status === 200 && response.type === 'basic') keep(event, request, response.clone());
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // a file that fails does not stop the worker: it is cached when first used
    await Promise.all([
      cache.add(new Request(SHELL_KEY, { cache: 'no-cache' })).catch(() => undefined),
      ...SW_PRECACHE.map((path) => cache.add(path).catch(() => undefined)),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const route = routeOf(event.request);
  if (route === 'shell') event.respondWith(shell(event));
  else if (route === 'asset') event.respondWith(asset(event));
});
