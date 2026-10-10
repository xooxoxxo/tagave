/**
 * The passkey configuration: RP ID and origin come from PUBLIC_URL, user
 * verification is required, and the server refuses an assertion or a
 * registration whose UV flag is off even if a browser let it through.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { USER_VERIFICATION_REQUIRED, createAuth, readAuthEnv } from './index.js';

// postgres.js connects lazily: nothing here touches a database.
const handle = createAuth({
  env: readAuthEnv({ APP_SECRET: 'c'.repeat(64), PUBLIC_URL: 'https://music.example.com' }),
  databaseUrl: 'postgres://nobody@127.0.0.1:1/none',
});

afterAll(() => handle.close());

interface PasskeyPluginOptions {
  rpID: string;
  origin: string;
  authenticatorSelection: { userVerification: string; residentKey: string };
  registration: { afterVerification: (args: unknown) => unknown };
  authentication: { afterVerification: (args: unknown) => unknown };
}

function passkeyOptions(): PasskeyPluginOptions {
  const plugin = (handle.auth.options.plugins as Array<{ id: string; options?: unknown }>).find((p) => p.id === 'passkey');
  if (!plugin) throw new Error('passkey plugin missing');
  return plugin.options as PasskeyPluginOptions;
}

describe('passkey options', () => {
  it('binds credentials to PUBLIC_URL and requires user verification', () => {
    const o = passkeyOptions();
    expect(o.rpID).toBe('music.example.com');
    expect(o.origin).toBe('https://music.example.com');
    expect(o.authenticatorSelection).toEqual({ residentKey: 'preferred', userVerification: 'required' });
  });

  it('refuses a sign-in assertion without user verification', () => {
    const o = passkeyOptions();
    expect(() => o.authentication.afterVerification({ verification: { authenticationInfo: { userVerified: false } } })).toThrow(
      expect.objectContaining({ body: expect.objectContaining({ code: USER_VERIFICATION_REQUIRED }) }),
    );
    expect(() => o.authentication.afterVerification({ verification: { authenticationInfo: { userVerified: true } } })).not.toThrow();
  });

  it('refuses a registration without user verification', () => {
    const o = passkeyOptions();
    expect(() => o.registration.afterVerification({ verification: { registrationInfo: { userVerified: false } } })).toThrow(/PIN or fingerprint/);
    expect(() => o.registration.afterVerification({ verification: { registrationInfo: { userVerified: true } } })).not.toThrow();
  });
});
