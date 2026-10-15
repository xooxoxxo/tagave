/**
 * The cache folder of a process started without CACHE_DIR (a source checkout
 * or a bare-node worker; the images always set it): ~/tagave-cache. A home
 * that only has ~/liner-cache, the folder releases before 0.9 used, keeps
 * using that one, so its cached cover art is not fetched again.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function defaultCacheDir(home: string, exists: (path: string) => boolean = existsSync): string {
  const current = join(home, 'tagave-cache');
  const legacy = join(home, 'liner-cache');
  return !exists(current) && exists(legacy) ? legacy : current;
}
