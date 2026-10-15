/**
 * Auth L3: authenticator app (TOTP), backup codes and the revocable list of
 * trusted devices, end to end through Fastify; plus `reseal` keeping TOTP
 * working across an APP_SECRET rotation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { resealTwoFactorSecrets, type AuthHandle } from '@tagave/auth';
import {
  TEST_APP_SECRET,
  TEST_PUBLIC_URL,
  buildAuthApp,
  cookieHeader,
  cookieJar,
  createScratchDb,
  migrateAll,
  testAuth,
  totpFromUri,
} from '../testkit/authApp.js';

const url = process.env.TEST_DATABASE_URL;
const EMAIL = 'owner@example.com';
const PASSWORD = 'correct horse battery';
const SESSION = 'tagave.session_token';
const TRUST = 'tagave.trust_device';

type Jar = Record<string, string>;

describe.skipIf(!url)('two-factor sign-in (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let handle: AuthHandle;
  let app: FastifyInstance;
  let totpUri: string;
  let backupCodes: string[];

  const json = (jar: Jar = {}) => ({ origin: TEST_PUBLIC_URL, 'content-type': 'application/json', cookie: cookieHeader(jar) });

  async function signIn(jar: Jar = {}) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: json(jar), payload: { email: EMAIL, password: PASSWORD } });
    return { res, jar: cookieJar(res.headers['set-cookie'], { ...jar }) };
  }

  async function signOut(jar: Jar) {
    await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { origin: TEST_PUBLIC_URL, cookie: cookieHeader(jar) } });
    const next = { ...jar };
    delete next[SESSION];
    return next;
  }

  async function security(jar: Jar) {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/security', headers: { cookie: cookieHeader(jar) } });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  beforeAll(async () => {
    process.env.ALLOW_INSECURE_HTTP = 'true';
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateAll(db.url);
    handle = testAuth(db.url);
    app = await buildAuthApp(handle);
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin: TEST_PUBLIC_URL },
      payload: { email: EMAIL, password: PASSWORD, displayName: 'Owner', contactString: EMAIL },
    });
    expect(setup.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('enrols the authenticator app only after a correct code', async () => {
    const { jar } = await signIn();
    expect((await security(jar)).twoFactor).toEqual({ enabled: false, backupCodesLeft: null });

    const wrongPw = await app.inject({ method: 'POST', url: '/api/auth/two-factor/enable', headers: json(jar), payload: { password: 'nope nope nope' } });
    expect(wrongPw.statusCode).toBe(400);

    const enable = await app.inject({ method: 'POST', url: '/api/auth/two-factor/enable', headers: json(jar), payload: { password: PASSWORD } });
    expect(enable.statusCode).toBe(200);
    totpUri = enable.json().totpURI;
    backupCodes = enable.json().backupCodes;
    expect(totpUri).toMatch(/^otpauth:\/\/totp\/tagave:owner%40example\.com\?/);
    expect(backupCodes).toHaveLength(10);
    // Not on until verified: a sign-in now would still skip the code.
    expect((await security(jar)).twoFactor.enabled).toBe(false);

    const verify = await app.inject({ method: 'POST', url: '/api/auth/two-factor/verify-totp', headers: json(jar), payload: { code: totpFromUri(totpUri) } });
    expect(verify.statusCode).toBe(200);
    const after = cookieJar(verify.headers['set-cookie'], { ...jar });
    expect(await security(after)).toMatchObject({ twoFactor: { enabled: true, backupCodesLeft: 10 } });

    // The secret is stored encrypted, never in clear.
    const secret = new URL(totpUri).searchParams.get('secret')!;
    const [row] = await handle.sql`select secret, backup_codes from auth_two_factors`;
    expect(String(row!['secret'])).not.toContain(secret);
    expect(String(row!['backup_codes'])).not.toContain(backupCodes[0]!);
  });

  it('asks for the code after the password, and refuses a wrong one', async () => {
    const { res, jar } = await signIn();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    expect(jar[SESSION]).toBeUndefined();

    const wrong = await app.inject({ method: 'POST', url: '/api/auth/two-factor/verify-totp', headers: json(jar), payload: { code: '000000' === totpFromUri(totpUri) ? '111111' : '000000' } });
    expect(wrong.statusCode).toBe(401);

    const ok = await app.inject({ method: 'POST', url: '/api/auth/two-factor/verify-totp', headers: json(jar), payload: { code: totpFromUri(totpUri) } });
    expect(ok.statusCode).toBe(200);
    const signedIn = cookieJar(ok.headers['set-cookie'], { ...jar });
    expect(signedIn[SESSION]).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieHeader(signedIn) } })).statusCode).toBe(200);
  });

  it('keeps the legacy /api/v1/auth/login wrapper from skipping the code', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAIL, password: PASSWORD } });
    expect(res.statusCode).toBe(403);
    expect(cookieJar(res.headers['set-cookie'])[SESSION]).toBeUndefined();
  });

  it('trusts a device for 30 days, lists it, and asks again once it is revoked', async () => {
    const first = await signIn();
    const verify = await app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      headers: json(first.jar),
      payload: { code: totpFromUri(totpUri), trustDevice: true },
    });
    expect(verify.statusCode).toBe(200);
    let jar = cookieJar(verify.headers['set-cookie'], { ...first.jar });
    expect(jar[TRUST]).toBeTruthy();

    let sec = await security(jar);
    expect(sec.trustedDevices).toHaveLength(1);
    expect(sec.trustedDevices[0]).toMatchObject({ current: true });
    const deviceId = sec.trustedDevices[0].id;

    // Signed out and back in on this browser: no code asked, the same device row.
    jar = await signOut(jar);
    const again = await signIn(jar);
    expect(again.res.json().twoFactorRedirect).toBeUndefined();
    expect(again.jar[SESSION]).toBeTruthy();
    jar = again.jar;
    sec = await security(jar);
    expect(sec.trustedDevices.map((d: { id: string }) => d.id)).toEqual([deviceId]);
    expect(sec.trustedDevices[0].current).toBe(true);

    // Revoked from Settings: the next sign-in asks for the code again.
    const revoke = await app.inject({ method: 'DELETE', url: `/api/v1/auth/trusted-devices/${deviceId}`, headers: { cookie: cookieHeader(jar) } });
    expect(revoke.statusCode).toBe(204);
    expect((await security(jar)).trustedDevices).toEqual([]);
    jar = await signOut(jar);
    const asked = await signIn(jar);
    expect(asked.res.json().twoFactorRedirect).toBe(true);
  });

  it('signs in with a backup code, once per code', async () => {
    const { jar } = await signIn();
    const code = backupCodes[0]!;
    const ok = await app.inject({ method: 'POST', url: '/api/auth/two-factor/verify-backup-code', headers: json(jar), payload: { code } });
    expect(ok.statusCode).toBe(200);
    const signedIn = cookieJar(ok.headers['set-cookie'], { ...jar });
    expect((await security(signedIn)).twoFactor.backupCodesLeft).toBe(9);

    const second = await signIn();
    const reused = await app.inject({ method: 'POST', url: '/api/auth/two-factor/verify-backup-code', headers: json(second.jar), payload: { code } });
    expect(reused.statusCode).toBe(401);
  });

  it('forgets every trusted device when the authenticator is turned off', async () => {
    const first = await signIn();
    const verify = await app.inject({ method: 'POST', url: '/api/auth/two-factor/verify-totp', headers: json(first.jar), payload: { code: totpFromUri(totpUri), trustDevice: true } });
    const jar = cookieJar(verify.headers['set-cookie'], { ...first.jar });
    expect((await security(jar)).trustedDevices).toHaveLength(1);
    const owner = (await handle.sql`select id from users`)[0]!['id'] as string;

    const { revokeAllTrustedDevices } = await import('@tagave/auth');
    // (The /two-factor/disable hook calls this; exercised directly so the
    // authenticator stays on for the reseal test below.)
    expect(await revokeAllTrustedDevices(handle.sql, owner)).toBe(1);
    expect(await handle.sql`select 1 from auth_verifications where identifier like 'trust-device-%'`).toHaveLength(0);
    expect((await security(jar)).trustedDevices).toEqual([]);
  });

  it('keeps TOTP working after an APP_SECRET rotation with reseal', async () => {
    const NEW_SECRET = '9'.repeat(64);
    const result = await resealTwoFactorSecrets(handle.sql, TEST_APP_SECRET, NEW_SECRET);
    expect(result).toEqual({ rows: 1, resealed: 1, alreadyCurrent: 0 });
    // Idempotent.
    expect(await resealTwoFactorSecrets(handle.sql, TEST_APP_SECRET, NEW_SECRET)).toEqual({ rows: 1, resealed: 0, alreadyCurrent: 1 });
    // A secret that opens with neither is refused, changing nothing.
    await expect(resealTwoFactorSecrets(handle.sql, 'a'.repeat(64), 'b'.repeat(64))).rejects.toThrow(/cannot be decrypted/);

    // The app restarted on the new APP_SECRET: password + code still work.
    await app.close();
    await handle.close();
    handle = testAuth(db.url, NEW_SECRET);
    app = await buildAuthApp(handle);
    const { res, jar } = await signIn();
    expect(res.json().twoFactorRedirect).toBe(true);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/two-factor/verify-totp', headers: json(jar), payload: { code: totpFromUri(totpUri) } });
    expect(ok.statusCode).toBe(200);
    const backup = await signIn();
    const bc = await app.inject({ method: 'POST', url: '/api/auth/two-factor/verify-backup-code', headers: json(backup.jar), payload: { code: backupCodes[1]! } });
    expect(bc.statusCode).toBe(200);
  });

  it('turns the authenticator off with the password and forgets trusted devices', async () => {
    const { jar: pending } = await signIn();
    const ok = await app.inject({ method: 'POST', url: '/api/auth/two-factor/verify-totp', headers: json(pending), payload: { code: totpFromUri(totpUri), trustDevice: true } });
    const jar = cookieJar(ok.headers['set-cookie'], { ...pending });
    expect((await security(jar)).trustedDevices).toHaveLength(1);
    const off = await app.inject({ method: 'POST', url: '/api/auth/two-factor/disable', headers: json(jar), payload: { password: PASSWORD } });
    expect(off.statusCode).toBe(200);
    const after = cookieJar(off.headers['set-cookie'], { ...jar });
    expect(await security(after)).toMatchObject({ twoFactor: { enabled: false }, trustedDevices: [] });
    expect(await handle.sql`select 1 from auth_trusted_devices`).toHaveLength(0);
    const plain = await signIn();
    expect(plain.jar[SESSION]).toBeTruthy();
  });
});
