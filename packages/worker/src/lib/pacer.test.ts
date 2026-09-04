/**
 * Tests for pure pacer functions.
 */
import { describe, it, expect } from 'vitest';
import { cooldownMsForAttempt, isRateLimitError } from './pacer.js';

describe('cooldownMsForAttempt', () => {
  it('returns attempt * 60s when no retryAfterMs', () => {
    expect(cooldownMsForAttempt(1)).toBe(60_000);
    expect(cooldownMsForAttempt(2)).toBe(120_000);
    expect(cooldownMsForAttempt(3)).toBe(180_000);
  });

  it('returns max(retryAfterMs, attempt * 60s)', () => {
    // retryAfterMs is smaller: use attempt * 60s
    expect(cooldownMsForAttempt(1, 30_000)).toBe(60_000);
    // retryAfterMs is larger: use it
    expect(cooldownMsForAttempt(1, 120_000)).toBe(120_000);
    expect(cooldownMsForAttempt(2, 100_000)).toBe(120_000);
  });
});

describe('isRateLimitError', () => {
  it('recognizes 503 errors', () => {
    expect(isRateLimitError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isRateLimitError(new Error('Discogs rate limited (503)'))).toBe(true);
  });

  it('recognizes 429 errors', () => {
    expect(isRateLimitError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRateLimitError(new Error('rate limited (429)'))).toBe(true);
  });

  it('recognizes "rate limit" in message', () => {
    expect(isRateLimitError(new Error('Rate limit exceeded'))).toBe(true);
    expect(isRateLimitError(new Error('You have exceeded the rate limit'))).toBe(true);
  });

  it('rejects non-rate-limit errors', () => {
    expect(isRateLimitError(new Error('Not found'))).toBe(false);
    expect(isRateLimitError(new Error('Database connection failed'))).toBe(false);
    expect(isRateLimitError(new Error('Timeout'))).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isRateLimitError(new Error('RATE LIMIT'))).toBe(true);
    expect(isRateLimitError(new Error('Rate Limit'))).toBe(true);
  });
});
