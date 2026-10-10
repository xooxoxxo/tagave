import { describe, expect, it } from 'vitest';
import { signInErrorMessage } from './loginErrors';

describe('signInErrorMessage', () => {
  it('says wrong email or password without telling which', () => {
    expect(signInErrorMessage({ status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' })).toBe('Wrong email or password.');
  });

  it('explains rate limiting', () => {
    expect(signInErrorMessage({ status: 429 })).toMatch(/Too many attempts/);
  });

  it('names the address and the fix when the origin is not trusted', () => {
    const msg = signInErrorMessage({ status: 403, code: 'INVALID_ORIGIN' }, 'http://192.168.1.5:3100');
    expect(msg).toContain('http://192.168.1.5:3100');
    expect(msg).toContain('PUBLIC_URL');
    expect(msg).toContain('ALLOWED_ORIGINS');
  });

  it('covers the two-factor step', () => {
    expect(signInErrorMessage({ status: 401, code: 'INVALID_CODE' })).toMatch(/code is not right/);
    expect(signInErrorMessage({ status: 401, code: 'INVALID_BACKUP_CODE' })).toMatch(/backup code/);
    expect(signInErrorMessage({ status: 401, code: 'INVALID_TWO_FACTOR_COOKIE' })).toMatch(/took too long/);
    expect(signInErrorMessage({ status: 429, code: 'ACCOUNT_TEMPORARILY_LOCKED' })).toMatch(/Too many/);
  });

  it('separates a dead server from a failing one', () => {
    expect(signInErrorMessage({ status: 0 })).toMatch(/Cannot reach/);
    expect(signInErrorMessage({ status: 502 })).toMatch(/server failed/);
    expect(signInErrorMessage(null)).toMatch(/Sign-in failed/);
  });
});
