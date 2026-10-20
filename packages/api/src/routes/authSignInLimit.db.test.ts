/**
 * Sign-in is limited per account as well as per address: under the default
 * TRUST_PROXY a client on the LAN can name any address in X-Forwarded-For,
 * so a burst of wrong passwords for one account, each from a different
 * forged address, must still stop.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { createAuth, fastifyTrustProxy, parseTrustProxy, readAuthEnv, type AuthHandle } from '@tagave/auth';
import { TEST_APP_SECRET, TEST_PUBLIC_URL, buildAuthApp, createScratchDb, migrateAll } from '../testkit/authApp.js';
import { ACCOUNT_SIGN_IN_LIMITED, SIGN_IN_FAILURES_PER_ACCOUNT, resetAccountSignInLimits } from './betterAuth.js';

const url = process.env.TEST_DATABASE_URL;
const EMAIL = 'owner@example.com';
const PASSWORD = 'correct horse battery';
/** A reverse proxy on the Docker network: trusted by default, so its X-Forwarded-For names the client. */
const PROXY = '172.18.0.5';

describe.skipIf(!url)('sign-in limit per account (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let app: FastifyInstance;
  let n = 0;

  const signIn = (email: string, password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: PROXY,
      // a different forged client address every time
      headers: { origin: TEST_PUBLIC_URL, 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${(n++ % 250) + 1}` },
      payload: { email, password },
    });

  beforeAll(async () => {
    process.env.ALLOW_INSECURE_HTTP = 'true';
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateAll(db.url);
    // Better Auth's own per-address limiter on, as in production
    handle = createAuth({ env: readAuthEnv({ APP_SECRET: TEST_APP_SECRET, PUBLIC_URL: TEST_PUBLIC_URL }), databaseUrl: db.url, rateLimit: true, maxConnections: 4 });
    app = await buildAuthApp(handle, undefined, undefined, { trustProxy: fastifyTrustProxy(parseTrustProxy(undefined)) });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin: TEST_PUBLIC_URL },
      payload: { email: EMAIL, password: PASSWORD, displayName: 'Owner', contactString: EMAIL },
    });
    expect(setup.statusCode).toBe(201);
  });

  beforeEach(() => resetAccountSignInLimits());

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('a burst of wrong passwords from ever-new forged addresses trips the account limit', async () => {
    for (let i = 0; i < SIGN_IN_FAILURES_PER_ACCOUNT; i++) {
      expect((await signIn(EMAIL, `wrong ${i}`)).statusCode, `try ${i}`).toBe(401);
    }
    const refused = await signIn(EMAIL.toUpperCase(), PASSWORD);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: ACCOUNT_SIGN_IN_LIMITED });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // another account is not held up
    expect((await signIn('someone@example.com', 'wrong')).statusCode).toBe(401);
  });

  it('a right password does not count toward the limit', async () => {
    for (let i = 0; i < SIGN_IN_FAILURES_PER_ACCOUNT - 1; i++) expect((await signIn(EMAIL, `wrong ${i}`)).statusCode).toBe(401);
    for (let i = 0; i < 3; i++) expect((await signIn(EMAIL, PASSWORD)).statusCode).toBe(200);
    expect((await signIn(EMAIL, 'wrong again')).statusCode).toBe(401);
    expect((await signIn(EMAIL, 'and again')).statusCode).toBe(429);
  });
});
