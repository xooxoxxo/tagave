/**
 * Reverse proxy check: tagave trusts X-Forwarded-For from proxies on a
 * private network without being told (TRUST_PROXY unset). The app notes
 * requests that carry the header from a peer it does not trust, in a small
 * file in the cache folder; this check warns when one peer keeps sending it,
 * so a proxy on a public address (some cloud load balancers) or one missing
 * from an explicit TRUST_PROXY list is named with the fix. Silent otherwise.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { defaultCacheDir } from '@tagave/core';
import type { Check } from './checks.js';

export const FORWARDED_SEEN_FILE = 'forwarded-headers.json';

/** Requests from one peer before the check speaks: a stray probe is not a proxy. */
export const FORWARDED_SEEN_MIN = 5;
/** Older sightings are forgotten. */
const FORWARDED_SEEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the app rewrites the file while a peer keeps sending the header. */
const WRITE_EVERY_MS = 10 * 60 * 1000;

/** public: not a private address (default setting); unlisted: not in an explicit TRUST_PROXY list. */
export type ForwardedPeerKind = 'public' | 'unlisted';

export interface ForwardedSeen {
  peer: string;
  kind: ForwardedPeerKind;
  count: number;
  lastAt: string;
  /** TRUST_PROXY as the app read it: a changed setting makes the record moot. */
  trustProxy: string;
}

export interface ForwardedObserverOptions {
  cacheDir?: string | undefined;
  /** TRUST_PROXY as set (unset is ''). */
  trustProxyRaw: string;
  now?: () => number;
}

function cacheDirOf(cacheDir: string | undefined): string {
  return cacheDir || defaultCacheDir(os.homedir());
}

const plain = (a: string): string => a.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/**
 * The app's side, called for every request with the socket's peer, the
 * address Fastify settled on (request.ip) and whether the request carried
 * X-Forwarded-For. The header went unused when request.ip is still the peer.
 * Resolves to the record when it was written (tests).
 */
export function createForwardedObserver(
  opts: ForwardedObserverOptions,
): (peer: string | undefined, ip: string, forwarded: boolean) => Promise<ForwardedSeen | null> {
  const raw = opts.trustProxyRaw.trim();
  const lower = raw.toLowerCase();
  const isDefault = lower === '' || lower === 'private';
  // TRUST_PROXY=off: the owner said there is no proxy; nothing to say
  const off = ['off', 'false', 'no', '0'].includes(lower);
  const now = opts.now ?? Date.now;
  const counts = new Map<string, number>();
  let lastWrite = 0;
  let written: string | null = null;
  const file = path.join(cacheDirOf(opts.cacheDir), FORWARDED_SEEN_FILE);

  return async (peer, ip, forwarded) => {
    if (off || !forwarded || !peer) return null;
    const p = plain(peer);
    if (plain(ip) !== p) return null;
    const kind: ForwardedPeerKind = isDefault ? 'public' : 'unlisted';
    if (!counts.has(p) && counts.size >= 100) counts.clear();
    const count = (counts.get(p) ?? 0) + 1;
    counts.set(p, count);
    const t = now();
    if (count < FORWARDED_SEEN_MIN) return null;
    if (written === p && t - lastWrite < WRITE_EVERY_MS) return null;
    lastWrite = t;
    written = p;
    const record: ForwardedSeen = { peer: p, kind, count, lastAt: new Date(t).toISOString(), trustProxy: raw };
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(record), 'utf8');
      await fs.rename(tmp, file);
    } catch {
      // the cache-folder check reports an unwritable folder
    }
    return record;
  };
}

export async function checkForwardedHeaders(cacheDir?: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<Check> {
  const start = Date.now();
  const raw = (env['TRUST_PROXY'] ?? '').trim();
  const done = (status: Check['status'], detail: string): Check => ({ id: 'forwardedHeaders', title: 'Reverse Proxy', status, detail, durationMs: Date.now() - start });
  const setting = raw === '' ? 'TRUST_PROXY unset: proxies on private networks' : `TRUST_PROXY=${raw}`;

  let seen: ForwardedSeen | null = null;
  try {
    seen = JSON.parse(await fs.readFile(path.join(cacheDirOf(cacheDir), FORWARDED_SEEN_FILE), 'utf8')) as ForwardedSeen;
  } catch {
    return done('pass', setting);
  }
  const at = Date.parse(seen?.lastAt ?? '');
  if (
    !seen ||
    typeof seen.peer !== 'string' ||
    seen.trustProxy !== raw ||
    !Number.isFinite(at) ||
    now - at > FORWARDED_SEEN_MAX_AGE_MS ||
    !(seen.count >= FORWARDED_SEEN_MIN)
  ) {
    return done('pass', setting);
  }
  const why = seen.kind === 'unlisted' ? 'not in TRUST_PROXY' : 'not a private address';
  return done('warn', `X-Forwarded-For from ${seen.peer} ignored: ${why}. Visitors share its rate limits.`);
}
