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
