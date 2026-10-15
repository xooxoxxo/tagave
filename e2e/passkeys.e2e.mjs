#!/usr/bin/env node
/**
 * Passkeys end to end (auth plan §10, Playwright flow 1, plus flow 6) with
 * Chrome's virtual WebAuthn authenticators over CDP:
 *
 *   1. a throwaway user signs in with email + password;
 *   2. Settings › Security › "Add a security key" registers a USB (YubiKey-
 *      like) authenticator that verifies the user (PIN);
 *   3. sign out, then "Sign in with a passkey" signs back in with no password;
 *   4. a second, platform ("internal") authenticator is added as a passkey and
 *      signs in too;
 *   5. a key that stops verifying the user (no PIN check) is refused with a
 *      clear message.
 *
 * Run against a running build whose PUBLIC_URL is BASE_URL (never prod):
 *
 *   BASE_URL=http://localhost:3197 \
 *   DATABASE_URL=postgres://tagave:tagave@127.0.0.1:5435/tagave \
 *   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs \
 *   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *   node e2e/passkeys.e2e.mjs
 *
 * It creates one user (e2e-passkey-…@example.test) with its library and
 * deletes it (and everything that cascades from it) at the end.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromAuth = createRequire(path.join(here, '../packages/auth/package.json'));
const postgres = (await import(pathToFileURL(requireFromAuth.resolve('postgres')).href)).default;
const argon2 = (await import(pathToFileURL(requireFromAuth.resolve('argon2')).href)).default;
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : 'playwright-core');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3197';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (/prod|\.ts\.net|tagave\.(app|io)/i.test(DATABASE_URL + BASE_URL)) throw new Error('refusing to run against what looks like production');

const email = `e2e-passkey-${randomUUID().slice(0, 8)}@example.test`;
const password = 'e2e passkey password!';
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });

const results = [];
function step(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) throw new Error(`step failed: ${name} ${detail}`);
}

async function createUser() {
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const [user] = await sql`insert into users (email, display_name, password_hash, role)
                           values (${email}, 'E2E passkeys', ${hash}, 'owner') returning id`;
  await sql`insert into auth_accounts (user_id, account_id, provider_id, password)
            values (${user.id}, ${user.id}::text, 'credential', ${hash})`;
  await sql`insert into libraries (owner_user_id, name, settings)
            values (${user.id}, 'E2E library', ${sql.json({ contactString: email, onboardingCompletedAt: new Date().toISOString() })})`;
  return user.id;
}

async function me(page) {
  const res = await page.request.get(`${BASE_URL}/api/v1/auth/me`);
  return res.ok() ? (await res.json()).user : null;
}

async function signOut(page) {
  await page.request.post(`${BASE_URL}/api/auth/sign-out`, { headers: { origin: BASE_URL, 'content-type': 'application/json' }, data: {} });
  await page.context().clearCookies({ name: 'tagave.session_token' });
}

/**
 * On /login, a discoverable passkey may be taken by conditional UI (the
 * autofill request the page starts on load) before any click; otherwise
 * press "Sign in with a passkey". Returns which path signed in.
 */
async function passkeySignIn(page) {
  await page.goto('/login');
  try {
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 3000 });
    return 'autofill';
  } catch {
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
    return 'button';
  }
}

async function addAuthenticator(cdp, transport) {
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}

let userId;
let browser;
try {
  userId = await createUser();
  step('throwaway user created', true, email);

  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const usbKey = await addAuthenticator(cdp, 'usb');

  // 1. password sign-in through the SPA
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.locator('input#password').fill(password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  step('password sign-in', (await me(page))?.email === email);

  // 2. register the YubiKey-like security key
  await page.goto('/settings/security');
  await page.getByRole('heading', { name: 'Passkeys and security keys' }).waitFor();
  await page.getByRole('button', { name: 'Add a security key' }).click();
  await page.getByText('On this key or device only').first().waitFor({ timeout: 15000 });
  const keys = await sql`select credential_id, rp_id, device_type, transports from auth_passkeys where user_id = ${userId}`;
  step('security key registered', keys.length === 1 && keys[0].rp_id === new URL(BASE_URL).hostname, JSON.stringify(keys[0]));

  // 3. sign out, sign back in with the passkey only
  await signOut(page);
  step('signed out', (await me(page)) === null);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  step('passkey sign-in (security key)', (await me(page))?.email === email);

  // 4. a platform passkey as a second factor
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: usbKey }).catch(() => undefined);
  // keep the usb key's credential around for step 5 by re-adding it later is not
  // possible (credentials live in the authenticator), so step 5 uses this one.
  const platform = await addAuthenticator(cdp, 'internal');
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  for (let i = 0; i < 60; i++) {
    const r = await page.request.get(`${BASE_URL}/api/v1/auth/security`);
    if (r.ok() && (await r.json()).passkeys.length === 2) break;
    await page.waitForTimeout(250);
  }
  step('platform passkey registered (2 factors)', (await sql`select count(*)::int as n from auth_passkeys where user_id = ${userId}`)[0].n === 2);
  await page.getByText('2 factors set up. You can lose one and still get in.').waitFor();
  step('health line counts both factors', true);

  await signOut(page);
  const how = await passkeySignIn(page);
  step('passkey sign-in (platform)', (await me(page))?.email === email, `via ${how === 'autofill' ? 'conditional UI (autofill)' : 'the button'}`);

  // 5. the key stops verifying the user (no PIN/fingerprint check): no sign-in, and the reason is shown
  await signOut(page);
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId: platform, isUserVerified: false });
  await page.goto('/login');
  await page.waitForTimeout(1500); // let the autofill request settle (it must not sign in)
  if (page.url().includes('/login')) await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  const alert = page.getByRole('alert');
  await alert.waitFor({ timeout: 15000 });
  const text = (await alert.textContent()) ?? '';
  step('key without PIN/fingerprint check refused', (await me(page)) === null && /PIN or fingerprint/.test(text), text.trim());

  // 6. a key that cannot verify its user at all (a YubiKey with no PIN) cannot be registered
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId: platform, isUserVerified: true });
  const signedBack = await passkeySignIn(page);
  step('signed back in with the platform passkey', (await me(page))?.email === email, `via ${signedBack}`);
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: platform });
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: false, automaticPresenceSimulation: true },
  });
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Add a security key' }).click();
  const refusal = page.locator('[class*="banner"]').filter({ hasText: /PIN or fingerprint|PIN/ });
  await refusal.first().waitFor({ timeout: 15000 });
  const stillTwo = (await sql`select count(*)::int as n from auth_passkeys where user_id = ${userId}`)[0].n === 2;
  step('key with no PIN support refused at registration', stillTwo, ((await refusal.first().textContent()) ?? '').trim());

  console.log(`\npasskeys e2e: ${results.length} steps passed`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  if (userId) await sql`delete from users where id = ${userId}`.catch((e) => console.error('cleanup failed', e));
  await sql.end({ timeout: 2 });
}
