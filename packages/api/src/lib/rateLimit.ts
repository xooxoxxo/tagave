/**
 * A fixed-window counter per key (a user id or a client address), in
 * memory: enough for one api process. Used where a person, not Better Auth,
 * is the unit: Settings › Users changes and the public invite links.
 */
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../middleware/errorHandler.js';

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

  /** Throws 429 past the limit. */
  check(key: string, now = Date.now()): void {
    if (!this.allow(key, now)) {
      throw new ApiError(429, 'Too Many Requests', 'Too many tries. Wait a minute and try again.');
    }
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

/** The signed-in person, else the client address. */
export function rateKey(request: FastifyRequest): string {
  return request.user ? `user:${request.user.id}` : `ip:${request.ip}`;
}
