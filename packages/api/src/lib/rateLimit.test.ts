import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../middleware/errorHandler.js';
import { RateLimitError, RateLimiter, TtlCache } from './rateLimit.js';

describe('RateLimiter', () => {
  it('refuses past max within a window and allows again after it', () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.allow('a', 0)).toBe(true);
    expect(rl.allow('a', 10)).toBe(true);
    expect(rl.allow('a', 20)).toBe(false);
    expect(rl.allow('a', 1000)).toBe(true);
  });

  it('keeps a limited key limited when many other keys arrive', () => {
    const rl = new RateLimiter(1, 60_000, 100);
    expect(rl.allow('victim', 0)).toBe(true);
    expect(rl.allow('victim', 1)).toBe(false);
    // 99 more keys fill the cap; the victim's window is the oldest but still open.
    for (let i = 0; i < 99; i++) rl.allow(`k${i}`, 2);
    expect(rl.size).toBe(100);
    expect(rl.allow('victim', 3)).toBe(false);
  });

  it('drops expired windows before open ones', () => {
    const rl = new RateLimiter(1, 1000, 3);
    rl.allow('old', 0);
    rl.allow('live1', 900);
    rl.allow('live2', 950);
    rl.allow('new', 1500); // 'old' expired: it goes, the live ones stay
    expect(rl.size).toBe(3);
    expect(rl.allow('live1', 1600)).toBe(false);
    expect(rl.allow('live2', 1600)).toBe(false);
  });

  it('never grows past maxKeys', () => {
    const rl = new RateLimiter(1, 60_000, 50);
    for (let i = 0; i < 500; i++) rl.allow(`k${i}`, i);
    expect(rl.size).toBe(50);
  });

  it('a key whose window restarts moves to the back of the eviction order', () => {
    const rl = new RateLimiter(1, 100, 2);
    rl.allow('a', 0);
    rl.allow('b', 50);
    rl.allow('a', 120); // a restarts: now newer than b
    rl.allow('c', 140); // cap: b (start 50, still open) is the oldest and goes
    expect(rl.allow('a', 150)).toBe(false);
  });

  it('allows max calls per window, then refuses until the window ends', () => {
    const l = new RateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect([1, 2, 3].map((i) => l.allow('k', t0 + i))).toEqual([true, true, true]);
    expect(l.allow('k', t0 + 10)).toBe(false);
    expect(l.allow('other', t0 + 10)).toBe(true);
    expect(l.allow('k', t0 + 1 + 60_000)).toBe(true);
  });

  it('at the key cap, forgets expired windows first: a live refusal stays refused', () => {
    const l = new RateLimiter(1, 60_000, 10_000);
    for (let i = 0; i < 9_999; i++) l.allow(`old-${i}`, 0);
    l.allow('hot', 70_000);
    expect(l.allow('hot', 70_001)).toBe(false);
    for (let i = 0; i < 5; i++) l.allow(`new-${i}`, 70_010);
    expect(l.size).toBeLessThan(100);
    expect(l.allow('hot', 70_020)).toBe(false);
  });

  it('release gives back a hit taken in the window', () => {
    const l = new RateLimiter(2, 60_000);
    expect(l.allow('k', 0)).toBe(true);
    l.release('k', 0);
    expect(l.allow('k', 0)).toBe(true);
    expect(l.allow('k', 0)).toBe(true);
    expect(l.allow('k', 0)).toBe(false);
    l.release('k', 1000);
    l.release('k', 1000);
    expect(l.allow('k', 1000)).toBe(true);
    // nothing to give back outside the window, or for an unknown key
    l.release('k', 60_000);
    l.release('unknown', 0);
    expect(l.size).toBe(1);
  });

  it('release with the time a hit was taken leaves a window that restarted since alone', () => {
    const l = new RateLimiter(1, 60_000);
    expect(l.allow('k', 0)).toBe(true);
    // the window restarts at 61s; a release stamped 0 (taken in the old one) gives nothing back
    expect(l.allow('k', 61_000)).toBe(true);
    l.release('k', 0);
    expect(l.allow('k', 61_000)).toBe(false);
  });

  it('TtlCache: entries expire after the ttl or their own deadline; the oldest go at the cap', () => {
    const c = new TtlCache<number>(1000, 2);
    c.set('a', 1, 0);
    c.set('b', 2, 0, 500);
    expect(c.get('a', 999)).toBe(1);
    expect(c.get('a', 1000)).toBeUndefined();
    expect(c.has('b', 499)).toBe(true);
    expect(c.has('b', 500)).toBe(false);
    c.set('x', 1, 0);
    c.set('y', 2, 0);
    c.set('z', 3, 0);
    expect(c.size).toBe(2);
    expect(c.get('x', 1)).toBeUndefined();
    expect(c.get('z', 1)).toBe(3);
  });

  it('says how many seconds are left in the window', () => {
    const l = new RateLimiter(1, 60_000);
    l.allow('k', 0);
    expect(l.retryAfterS('k', 0)).toBe(60);
    expect(l.retryAfterS('k', 59_100)).toBe(1);
    expect(l.retryAfterS('k', 30_500)).toBe(30);
    expect(l.retryAfterS('unknown', 0)).toBe(1);
  });

  it('check throws a 429 that carries the seconds', () => {
    const l = new RateLimiter(1, 60_000);
    l.check('k', 0);
    let err: unknown;
    try {
      l.check('k', 20_000);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).status).toBe(429);
    expect((err as RateLimitError).retryAfterS).toBe(40);
  });
});

describe('a refused call over HTTP', () => {
  let app: FastifyInstance;
  const limit = new RateLimiter(2, 60_000);

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.get('/limited', async () => {
      limit.check('one');
      return { ok: true };
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 429 with Retry-After in whole seconds', async () => {
    expect((await app.inject({ method: 'GET', url: '/limited' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/limited' })).statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/limited' });
    expect(res.statusCode).toBe(429);
    const s = Number(res.headers['retry-after']);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(60);
    expect(res.json()).toMatchObject({ status: 429, title: 'Too Many Requests' });
  });
});
