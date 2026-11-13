import { describe, expect, it } from 'vitest';
import { betterAuthAllowed, genericCallbackLocation } from './betterAuth.js';

const ORIGIN = 'https://music.example.com';

describe('the login-service callback', () => {
  it('is the only OAuth path open over HTTP: flows start server-side', () => {
    expect(betterAuthAllowed('GET', '/api/auth/callback/oidc')).toBe(true);
    expect(betterAuthAllowed('POST', '/api/auth/callback/oidc')).toBe(false);
    expect(betterAuthAllowed('POST', '/api/auth/sign-in/social')).toBe(false);
    expect(betterAuthAllowed('POST', '/api/auth/link-social')).toBe(false);
    expect(betterAuthAllowed('POST', '/api/auth/unlink-account')).toBe(false);
    expect(betterAuthAllowed('GET', '/api/auth/callback/github')).toBe(false);
  });

  it('turns every refusal into one answer on the same page', () => {
    for (const code of ['account_not_linked', 'signup_disabled', 'oidc_refused', 'ACCOUNT_INACTIVE', 'state_mismatch']) {
      const out = genericCallbackLocation(`${ORIGIN}/login?error=${code}&error_description=This+account+is+turned+off`, ORIGIN);
      expect(out).toEqual({ location: `${ORIGIN}/login?oidc=failed`, code });
    }
    expect(genericCallbackLocation(`${ORIGIN}/settings/account?error=account_already_linked_to_different_user`, ORIGIN).location)
      .toBe(`${ORIGIN}/settings/account?oidc=failed`);
    // Better Auth's own error page (no error URL in a state it could not read)
    expect(genericCallbackLocation(`${ORIGIN}/api/auth/error?error=state_not_found`, ORIGIN).location).toBe(`${ORIGIN}/login?oidc=failed`);
    expect(genericCallbackLocation('https://elsewhere.example/?x', ORIGIN).location).toBe(`${ORIGIN}/login?oidc=failed`);
  });

  it('leaves a success alone', () => {
    expect(genericCallbackLocation(`${ORIGIN}/settings/account?oidc=linked`, ORIGIN)).toEqual({ location: `${ORIGIN}/settings/account?oidc=linked`, code: null });
    expect(genericCallbackLocation(`${ORIGIN}/`, ORIGIN).code).toBeNull();
  });
});
