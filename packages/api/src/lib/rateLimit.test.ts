import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rateLimit.js';

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
});
