#!/usr/bin/env node
/**
 * Re-verification with a passkey before an in-app update, end to end, in
 * real Chrome with a virtual platform authenticator over CDP:
 *
 *   1. a throwaway owner signs in with a password and adds a passkey;
 *   2. signs out and back in with the password (the sign-in page starts its
 *      autofill passkey request, which must not outlive the page), then the
 *      session is aged past five minutes in the database;
 *   3. Settings › Updates › Update to <version> asks to confirm it is you;
 *      the passkey confirms it and the update request reaches the updater;
 *   4. a passkey that does not check its user is refused with a clear message;
 *   5. Cancel ends a passkey request nobody answers; the next one works;
 *   6. a passkey request nobody answers stops after 60 s with a clear message;
 *      the next one works;
 *   7. with an authenticator app as well (needs APP_SECRET, the server's, to
 *      store its secret): switching to it while the passkey request is open
 *      ends that request, and the code confirms.
 *
 * Needs a running build whose PUBLIC_URL is BASE_URL (http://localhost is
 * fine for WebAuthn), TAGAVE_UPDATER_URL and TAGAVE_UPDATE_FEED pointing at
 * e2e/fake-updater.mjs, and TAGAVE_BUILD_VERSION older than the fake's release:
 *
 *   PORT=3299 RELEASES=0.7.3 node e2e/fake-updater.mjs &
 *   BASE_URL=http://localhost:3197 UPDATER_URL=http://127.0.0.1:3299 \
 *   DATABASE_URL=postgres://…/tagave_e2e \
 *   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs \
 *   node e2e/stepup.e2e.mjs
 *
 * Never point it at production: it writes to the database. It creates one
 * user (e2e-stepup-…@example.test) and deletes it at the end.
 */
import { createRequire } from 'node:module';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromAuth = createRequire(path.join(here, '../packages/auth/package.json'));
const postgres = (await import(pathToFileURL(requireFromAuth.resolve('postgres')).href)).default;
const argon2 = (await import(pathToFileURL(requireFromAuth.resolve('argon2')).href)).default;
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : 'playwright-core');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3197';
const UPDATER_URL = process.env.UPDATER_URL ?? 'http://127.0.0.1:3299';
const DATABASE_URL = process.env.DATABASE_URL;
const SKIP_TIMEOUT = process.env.SKIP_TIMEOUT === '1';
const APP_SECRET = process.env.APP_SECRET;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (/prod|\.ts\.net|tagave\.(app|io)/i.test(DATABASE_URL + BASE_URL)) throw new Error('refusing to run against what looks like production');

const email = `e2e-stepup-${randomUUID().slice(0, 8)}@example.test`;
const password = 'e2e step-up password!';
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
                           values (${email}, 'E2E step-up', ${hash}, 'owner') returning id`;
  await sql`insert into auth_accounts (user_id, account_id, provider_id, password)
            values (${user.id}, ${user.id}::text, 'credential', ${hash})`;
  const [lib] = await sql`insert into libraries (owner_user_id, name, settings)
            values (${user.id}, 'E2E library', ${sql.json({ contactString: email, onboardingCompletedAt: new Date().toISOString() })}) returning id`;
  return { userId: user.id, libraryId: lib.id };
}

const updater = {
  reset: () => fetch(`${UPDATER_URL}/_test/reset`, { method: 'POST' }),
  requests: async () => (await fetch(`${UPDATER_URL}/_test/updates`)).json(),
  /** The update requests, once `n` have arrived (or after 10 s). */
  async received(n = 1) {
    for (let i = 0; i < 40; i++) {
      const r = await this.requests();
      if (r.length >= n) return r;
      await new Promise((ok) => setTimeout(ok, 250));
    }
    return this.requests();
  },
};

/** Make every session of the user older than the five-minute window: the test's stand-in for waiting. */
async function ageSessions(userId) {
  await sql`delete from auth_step_ups where user_id = ${userId}`;
  await sql`update auth_sessions set created_at = now() - interval '10 minutes' where user_id = ${userId}`;
}

/** Give the user an authenticator app, stored the way Better Auth's two-factor plugin stores it. */
async function addTotp(userId, secret) {
  const { symmetricEncrypt } = await import(pathToFileURL(requireFromAuth.resolve('better-auth/crypto')).href);
  const { deriveAuthSecret } = await import(pathToFileURL(path.join(here, '../packages/auth/dist/config.js')).href);
  const data = await symmetricEncrypt({ key: deriveAuthSecret(APP_SECRET), data: secret });
  await sql`insert into auth_two_factors (user_id, secret, backup_codes) values (${userId}, ${data}, ${await symmetricEncrypt({ key: deriveAuthSecret(APP_SECRET), data: '[]' })})`;
  await sql`update users set two_factor_enabled = true where id = ${userId}`;
}

/** RFC 6238, as the server checks it (SHA-1, 6 digits, 30 s). */
function totp(secret, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const mac = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function me(page) {
  const res = await page.request.get(`${BASE_URL}/api/v1/auth/me`);
  return res.ok() ? (await res.json()).user : null;
}

async function signOut(page) {
  await page.request.post(`${BASE_URL}/api/auth/sign-out`, { headers: { origin: BASE_URL, 'content-type': 'application/json' }, data: {} });
  await page.context().clearCookies({ name: 'tagave.session_token' });
}

/** Settings › Updates › Update to …, through the confirm, up to the re-verify dialog. */
async function openStepUp(page, version) {
  await page.getByRole('button', { name: `Update to ${version}`, exact: true }).click();
  const confirm = page.getByRole('dialog', { name: `Update to ${version}?` });
  await confirm.getByRole('button', { name: `Update to ${version}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await dialog.waitFor({ timeout: 10000 });
  return dialog;
}

let userId;
let browser;
let page;
try {
  const created = await createUser();
  userId = created.userId;
  step('throwaway owner created', true, email);
  await updater.reset();

  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const presence = (enabled) => cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled });
  const verified = (isUserVerified) => cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified });

  // 1. password sign-in, then a platform passkey
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.locator('input#password').fill(password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  for (let i = 0; i < 60; i++) {
    if ((await sql`select count(*)::int as n from auth_passkeys where user_id = ${userId}`)[0].n === 1) break;
    await page.waitForTimeout(250);
  }
  const [key] = await sql`select transports, rp_id from auth_passkeys where user_id = ${userId}`;
  step('platform passkey registered', !!key && key.rp_id === new URL(BASE_URL).hostname, JSON.stringify(key ?? {}));

  // 2. sign back in with the password. With presence off the virtual
  // authenticator cannot answer the page's autofill passkey request, so it
  // stays open, as it does in a real browser until a passkey is picked.
  await signOut(page);
  await presence(false);
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.locator('input#password').fill(password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  step('password sign-in with the autofill request left open', (await me(page))?.email === email);

  // To Settings › Updates without a reload, so the page that ran the sign-in stays loaded.
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('link', { name: 'Updates', exact: true }).click();
  await page.getByRole('button', { name: 'Check now' }).click();
  const version = '0.7.3';
  await page.getByRole('button', { name: `Update to ${version}`, exact: true }).waitFor({ timeout: 15000 });
  await ageSessions(userId);
  await presence(true);

  // 3. passkey → update request reaches the updater
  let dialog = await openStepUp(page, version);
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.getByText(`Updating to ${version}`).first().waitFor({ timeout: 15000 });
  let reqs = await updater.received();
  step('passkey re-verification → update request reaches the updater', reqs.length === 1 && reqs[0].version === version, JSON.stringify(reqs));
  const [su] = await sql`select method from auth_step_ups where user_id = ${userId}`;
  step('re-verification recorded as passkey', su?.method === 'passkey');

  const again = async () => {
    await updater.reset();
    await ageSessions(userId);
    await page.reload();
    await page.getByRole('button', { name: `Update to ${version}`, exact: true }).waitFor({ timeout: 15000 });
  };

  // 4. the passkey does not verify its user
  await again();
  await verified(false);
  dialog = await openStepUp(page, version);
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  let alert = dialog.getByRole('alert');
  await alert.waitFor({ timeout: 15000 });
  let text = ((await alert.textContent()) ?? '').trim();
  reqs = await updater.requests();
  step('passkey without PIN/fingerprint check refused with a clear message', reqs.length === 0 && /PIN or fingerprint|not accepted/.test(text), text);
  step('dialog usable after the error', await dialog.getByRole('button', { name: 'Use passkey' }).isEnabled());
  await verified(true);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });

  // 5. Cancel ends a request nobody answers
  await presence(false);
  dialog = await openStepUp(page, version);
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  await dialog.getByText('Waiting for your passkey or security key…').waitFor({ timeout: 5000 });
  await page.waitForTimeout(1000);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  step('Cancel closes the dialog while the passkey request is open', (await updater.requests()).length === 0);
  await presence(true);
  dialog = await openStepUp(page, version);
  await dialog.getByRole('button', { name: 'Use passkey' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  reqs = await updater.received();
  step('after Cancel the next passkey request works (the first one was ended)', reqs.length === 1, JSON.stringify(reqs));

  // 6. timeout
  if (SKIP_TIMEOUT) {
    console.log('skip timeout (SKIP_TIMEOUT=1)');
  } else {
    await again();
    await presence(false);
    dialog = await openStepUp(page, version);
    const t0 = Date.now();
    await dialog.getByRole('button', { name: 'Use passkey' }).click();
    alert = dialog.getByRole('alert');
    await alert.waitFor({ timeout: 75000 });
    text = ((await alert.textContent()) ?? '').trim();
    const took = Math.round((Date.now() - t0) / 1000);
    step('an unanswered passkey request stops after 60 s with a clear message', /within 60 seconds/.test(text) && took >= 58 && took <= 70, `${took} s: ${text}`);
    await presence(true);
    await dialog.getByRole('button', { name: 'Use passkey' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 15000 });
    reqs = await updater.received();
    step('after the timeout the next passkey request works', reqs.length === 1, JSON.stringify(reqs));
  }

  // 7. switch to the authenticator app while the passkey request is open
  if (!APP_SECRET) {
    console.log('skip method switch (APP_SECRET not set)');
  } else {
    await addTotp(userId, 'e2e-totp-secret-0123456789');
    await again();
    await presence(false);
    dialog = await openStepUp(page, version);
    await dialog.getByRole('button', { name: 'Use passkey' }).click();
    await dialog.getByText('Waiting for your passkey or security key…').waitFor({ timeout: 5000 });
    await dialog.getByRole('button', { name: 'Use the authenticator app' }).click();
    await dialog.getByLabel('Code from your authenticator app').fill(totp('e2e-totp-secret-0123456789'));
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 15000 });
    reqs = await updater.received();
    const [m] = await sql`select method from auth_step_ups where user_id = ${userId}`;
    step('switching to the authenticator app while the passkey request is open works', reqs.length === 1 && m?.method === 'totp', `${m?.method} ${JSON.stringify(reqs)}`);
    await presence(true);
    await again();
    dialog = await openStepUp(page, version);
    await dialog.getByRole('button', { name: 'Use passkey' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 15000 });
    step('the passkey works again afterwards (the switched-away request was ended)', (await updater.received()).length === 1);
  }

  console.log(`\nstep-up e2e: ${results.length} steps passed`);
} catch (err) {
  console.error(err);
  const open = await page?.locator('dialog[open]').allInnerTexts().catch(() => []);
  if (open?.length) console.error('open dialog:', open.join('\n---\n'));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await updater.reset().catch(() => undefined);
  if (userId) await sql`delete from users where id = ${userId}`.catch((e) => console.error('cleanup failed', e));
  await sql.end({ timeout: 2 });
}
