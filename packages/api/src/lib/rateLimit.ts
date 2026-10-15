/**
 * A fixed-window counter per key (a user id or a client address), in
 * memory: enough for one api process. Used where a person, not Better Auth,
 * is the unit: Settings › Users changes and the public invite links.
 */
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../middleware/errorHandler.js';

export class RateLimiter {
  private readonly hits = new Map<string, { start: number; n: number }>();
  constructor(readonly max: number, readonly windowMs: number) {}

  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      if (this.hits.size > 10_000) this.hits.clear();
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

  reset(): void {
    this.hits.clear();
  }
}

/** The signed-in person, else the client address. */
export function rateKey(request: FastifyRequest): string {
  return request.user ? `user:${request.user.id}` : `ip:${request.ip}`;
}
