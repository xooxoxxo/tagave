/**
 * A fixed-window counter per key (a user id, a client address or an access
 * token), in memory: enough for one api process. Used where a person, not
 * Better Auth, is the unit: Settings › Users changes, the public invite
 * links, the Music Connections endpoints and feeds.
 *
 * A refusal says when to come back: the 429 carries Retry-After, the seconds
 * left in the key's window (errorHandler sets it from RateLimitError).
 */
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../middleware/errorHandler.js';

export class RateLimitError extends ApiError {
  constructor(readonly retryAfterS: number, detail = 'Too many tries. Wait a minute and try again.') {
    super(429, 'Too Many Requests', detail);
  }
}

export class RateLimiter {
  /** Insertion order is window-start order: a key is re-inserted when its window restarts. */
  private readonly hits = new Map<string, { start: number; n: number }>();
  constructor(readonly max: number, readonly windowMs: number, readonly maxKeys = 50_000) {}

  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      this.hits.delete(key);
      if (this.hits.size >= this.maxKeys) this.evict(now);
      this.hits.set(key, { start: now, n: 1 });
      return true;
    }
    h.n += 1;
    return h.n <= this.max;
  }

  /**
   * Hands back one hit taken by allow/check in the key's current window: for
   * a limit on failures, take a hit before the try (so calls at once cannot
   * all pass) and give it back when the try succeeds.
   */
  release(key: string, now = Date.now()): void {
    const h = this.hits.get(key);
    // `now` is when the hit was taken: a window that restarted since keeps its count
    if (h && now >= h.start && now - h.start < this.windowMs && h.n > 0) h.n -= 1;
  }

  /** Whole seconds until the key's window resets (at least 1). */
  retryAfterS(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    if (!h) return 1;
    return Math.max(1, Math.ceil((h.start + this.windowMs - now) / 1000));
  }

  /** Throws 429 (with Retry-After) past the limit. */
  check(key: string, now = Date.now(), detail?: string): void {
    if (!this.allow(key, now)) throw new RateLimitError(this.retryAfterS(key, now), detail);
  }

  /**
   * Makes room for one key without forgetting the counts of other keys in
   * their window wholesale (clearing everything would let anyone who sends
   * from enough distinct keys reset every limit). Expired windows go first;
   * if every window is still open, the oldest-started ones go.
   */
  private evict(now: number): void {
    for (const [k, v] of this.hits) {
      if (now - v.start < this.windowMs) break;
      this.hits.delete(k);
    }
    for (const k of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(k);
    }
  }

  /** Keys currently tracked (tests). */
  get size(): number {
    return this.hits.size;
  }

  reset(): void {
    this.hits.clear();
  }
}

/**
 * A bounded map whose entries expire: at most `maxKeys` (the oldest set goes
 * first), each for `ttlMs` or until its own `until`, whichever is sooner.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { v: V; until: number }>();
  constructor(readonly ttlMs: number, readonly maxKeys = 10_000) {}

  get(key: string, now = Date.now()): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (now >= e.until) {
      this.entries.delete(key);
      return undefined;
    }
    return e.v;
  }

  has(key: string, now = Date.now()): boolean {
    return this.get(key, now) !== undefined;
  }

  set(key: string, v: V, now = Date.now(), until = Infinity): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { v, until: Math.min(now + this.ttlMs, until) });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  reset(): void {
    this.entries.clear();
  }
}

/** The signed-in person, else the client address (request.ip: TRUST_PROXY decides which hop that is). */
export function rateKey(request: FastifyRequest): string {
  return request.user ? `user:${request.user.id}` : `ip:${request.ip}`;
}
