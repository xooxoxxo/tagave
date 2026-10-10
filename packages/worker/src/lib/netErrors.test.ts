import { describe, expect, it } from 'vitest';
import { isTransientNetworkError } from './netErrors.js';
import { enrichErrorIsRetryable } from '../jobs/enrichRelease.js';

/** What undici's fetch throws when the connection times out (2026-10-08 outage logs). */
function fetchFailed(code: string): Error {
  const inner = Object.assign(new Error(`connect ${code} 104.18.0.1:443`), { code });
  const agg = Object.assign(new AggregateError([inner], ''), { code });
  return new TypeError('fetch failed', { cause: agg });
}

describe('isTransientNetworkError', () => {
  it.each(['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'])(
    'treats fetch failed / %s as transient', (code) => {
      expect(isTransientNetworkError(fetchFailed(code))).toBe(true);
    });

  it('treats an AbortSignal.timeout as transient', () => {
    const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('does not treat a provider answer as transient', () => {
    expect(isTransientNetworkError(new Error('MusicBrainz lookup failed: Not Found'))).toBe(false);
    expect(isTransientNetworkError(Object.assign(new Error('bad'), { code: '23505' }))).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
  });
});

describe('enrichErrorIsRetryable', () => {
  it('retries rate limits and network failures, records the rest as attempted', () => {
    expect(enrichErrorIsRetryable(new Error('MusicBrainz rate limited (503): busy'))).toBe(true);
    expect(enrichErrorIsRetryable(fetchFailed('ETIMEDOUT'))).toBe(true);
    expect(enrichErrorIsRetryable(new Error('Discogs release 1 not found (404)'))).toBe(false);
  });
});
