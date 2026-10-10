/**
 * The SPA signs in and out through Better Auth (/api/auth/*); nothing goes
 * to the legacy /api/v1/auth/login or /logout wrappers any more (auth L2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];

function stubFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('window', { location: { origin: 'http://localhost:3100', href: 'http://localhost:3100/login' } });
  vi.resetModules();
});

afterEach(() => vi.unstubAllGlobals());

describe('sign-in through Better Auth', () => {
  it('posts to /api/auth/sign-in/email and reports a finished sign-in', async () => {
    stubFetch({ redirect: false, token: 't', user: { id: 'u' } });
    const { signInWithPassword } = await import('./useAuth');
    await expect(signInWithPassword({ email: 'me@example.com', password: 'twelve-chars!' })).resolves.toEqual({ status: 'signed-in' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\/api\/auth\/sign-in\/email$/);
    expect(calls.some((c) => c.includes('/api/v1/auth/login'))).toBe(false);
  });

  it('sends a 2FA account to the code step', async () => {
    stubFetch({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    const { signInWithPassword } = await import('./useAuth');
    await expect(signInWithPassword({ email: 'me@example.com', password: 'twelve-chars!' })).resolves.toEqual({ status: 'two-factor' });
  });

  it('throws the Better Auth error for the login page to explain', async () => {
    stubFetch({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }, 401);
    const { signInWithPassword } = await import('./useAuth');
    await expect(signInWithPassword({ email: 'me@example.com', password: 'wrong-password' })).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_EMAIL_OR_PASSWORD',
    });
  });

  it('signs out at /api/auth/sign-out', async () => {
    stubFetch({ success: true });
    const { signOut } = await import('./useAuth');
    await signOut();
    expect(calls[0]).toMatch(/\/api\/auth\/sign-out$/);
    expect(calls.some((c) => c.includes('/api/v1/auth/logout'))).toBe(false);
  });
});
