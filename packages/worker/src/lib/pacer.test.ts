/**
 * Tests for pure pacer functions.
 */
import { describe, it, expect } from 'vitest';
import { cooldownMsForAttempt, isRateLimitError, isServerBusyError } from './pacer.js';

describe('cooldownMsForAttempt', () => {
  it('returns attempt * 60s when no retryAfterMs', () => {
    expect(cooldownMsForAttempt(1)).toBe(5_000);
    expect(cooldownMsForAttempt(2)).toBe(15_000);
    expect(cooldownMsForAttempt(3)).toBe(45_000);
  });

  it('escalates 5s → 15s → 45s and lets a longer Retry-After win', () => {
    expect(cooldownMsForAttempt(1)).toBe(5_000);
    expect(cooldownMsForAttempt(2)).toBe(15_000);
    expect(cooldownMsForAttempt(3)).toBe(45_000);
    expect(cooldownMsForAttempt(9)).toBe(45_000); // capped
    // Retry-After shorter than the ladder: ladder wins
    expect(cooldownMsForAttempt(1, 3_000)).toBe(5_000);
    // Retry-After longer: it wins
    expect(cooldownMsForAttempt(1, 120_000)).toBe(120_000);
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

describe('isServerBusyError', () => {
  it('recognises the MusicBrainz busy body but not a real rate-limit', () => {
    expect(isServerBusyError(new Error('MusicBrainz rate limited (503): {"error": "The MusicBrainz web server is currently busy. Please try again later."}'))).toBe(true);
    expect(isServerBusyError(new Error('MusicBrainz rate limited (503): {"error": "Your requests are exceeding the allowable rate limit."}'))).toBe(false);
    expect(isServerBusyError(new Error('Discogs rate limited (429): retry after 30s'))).toBe(false);
  });
});
