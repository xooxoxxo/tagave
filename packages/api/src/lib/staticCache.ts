import path from 'node:path';

/**
 * Cache-Control for the web build. Vite names everything under assets/ by
 * content hash, so a cached copy can never be stale: cache it for a year and
 * skip revalidation. Anything else (index.html, the favicon) must be
 * revalidated on every load, or a deploy would leave browsers on an
 * index.html that points at hashed files the new build no longer has.
 * Before this every file went out as `public, max-age=0` (audit 2026-10-10).
 */
export function staticCacheControl(filePath: string): string {
  const parts = filePath.split(path.sep);
  return parts.includes('assets') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

/**
 * Whether a request the static files did not answer gets the app shell
 * (index.html), for the SPA's deep links. Not for /api, and not for a file
 * under /assets/: one that is missing is an old build's chunk after an
 * update, and answering it with the shell (200, text/html) made the stale
 * tab's import fail with a MIME error instead of a plain 404. Nor for the
 * Music Connections feeds (/mc/) and discovery (/.well-known/): another app
 * reads those, and an unknown path there must be a JSON 404, not a page.
 */
export function servesAppShell(method: string, url: string): boolean {
  if (method !== 'GET') return false;
  const pathname = (url.split('?')[0] ?? '').toLowerCase();
  return !NO_SHELL_PREFIXES.some((p) => pathname === p.slice(0, -1) || pathname.startsWith(p));
}

const NO_SHELL_PREFIXES = ['/api/', '/assets/', '/mc/', '/.well-known/'];

/** Paths whose every answer, a 404 included, must never be cached (the /mc feeds). */
export function isNoStorePath(url: string): boolean {
  const pathname = (url.split('?')[0] ?? '').toLowerCase();
  return pathname === '/mc' || pathname.startsWith('/mc/');
}
