#!/usr/bin/env node
/**
 * An open tab after tagave was updated, end to end, in real Chrome:
 *
 *   1. tabs open on build A; the app is swapped for build B (another sha,
 *      A's hashed files gone) and restarted;
 *   2. a tab that gets focus asks the server and shows "tagave was updated."
 *      with a Reload button (its job stream is blocked here, so only the
 *      focus can have told it), and does not reload by itself;
 *   3. a tab that follows its job stream back after the restart shows the
 *      note too (screenshots: light and dark, 1440 and 390 wide);
 *   4. a tab on build A that opens a lazy page (whose file is gone) reloads
 *      once into build B and shows the page instead of breaking;
 *   5. Settings › Updates, watching the update run: once it succeeds, the
 *      success shows for about 2 s and the tab reloads into build B.
 *
 * It starts the app itself (packages/api/dist, so `pnpm -r build` first) and
 * e2e/fake-updater.mjs, and swaps packages/web/dist between two web builds
 * made with different GIT_SHA (the original dist is put back at the end):
 *
 *   (cd packages/web && GIT_SHA=aaaa1111 LINER_VERSION=0.7.6 pnpm build && cp -R dist /tmp/dist-a)
 *   (cd packages/web && GIT_SHA=bbbb2222 LINER_VERSION=0.7.7 pnpm build && cp -R dist /tmp/dist-b)
 *   DIST_A=/tmp/dist-a SHA_A=aaaa1111 DIST_B=/tmp/dist-b SHA_B=bbbb2222 \
 *   DATABASE_URL=postgres://…/liner_e2e APP_SECRET=<64 hex> \
 *   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs SHOTS=/tmp/shots \
 *   node e2e/reload-after-update.e2e.mjs
 *
 * Never point it at production: it writes to the database. It creates one
 * user (e2e-reload-…@example.test) and deletes it at the end.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const requireFromAuth = createRequire(path.join(root, 'packages/auth/package.json'));
const postgres = (await import(pathToFileURL(requireFromAuth.resolve('postgres')).href)).default;
const argon2 = (await import(pathToFileURL(requireFromAuth.resolve('argon2')).href)).default;
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : 'playwright-core');

const PORT = Number(process.env.PORT ?? 3211);
const UPDATER_PORT = Number(process.env.UPDATER_PORT ?? 3311);
const BASE_URL = `http://localhost:${PORT}`;
const UPDATER_URL = `http://127.0.0.1:${UPDATER_PORT}`;
const { DATABASE_URL, APP_SECRET, DIST_A, DIST_B } = process.env;
const SHA_A = process.env.SHA_A ?? 'aaaa1111';
const SHA_B = process.env.SHA_B ?? 'bbbb2222';
const SHOTS = process.env.SHOTS ?? '';
for (const [k, v] of Object.entries({ DATABASE_URL, APP_SECRET, DIST_A, DIST_B })) if (!v) throw new Error(`${k} is required`);
if (/prod|\.ts\.net|tagave\.(app|io)/i.test(DATABASE_URL)) throw new Error('refusing to run against what looks like production');

const webDist = path.join(root, 'packages/web/dist');
const webDistSaved = `${webDist}.e2e-saved-${process.pid}`;

const email = `e2e-reload-${randomUUID().slice(0, 8)}@example.test`;
const password = 'e2e reload password!';
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });

function step(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) throw new Error(`step failed: ${name} ${detail}`);
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function waitFor(fn, { timeout = 15000, every = 200 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > until) return v;
    await sleep(every);
  }
}

// --- the app and the fake updater ---

function startProcess(args, env, name) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('exit', (code) => { if (code && code !== 143 && !child.stopping) console.log(`${name} exited ${code}\n${log.slice(-2000)}`); });
  child.log = () => log;
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.stopping = true;
  child.kill('SIGTERM');
  await waitFor(async () => child.exitCode !== null || child.signalCode !== null, { timeout: 10000 });
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function useWebBuild(dist) {
  rmSync(webDist, { recursive: true, force: true });
  cpSync(dist, webDist, { recursive: true });
}

async function startApp(sha, version) {
  const app = startProcess(['packages/api/dist/index.js'], {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    LOG_LEVEL: 'warn',
    DATABASE_URL,
    APP_SECRET,
    PUBLIC_URL: BASE_URL,
    LINER_GIT_SHA: sha,
    LINER_VERSION: version,
    TAGAVE_UPDATER_URL: UPDATER_URL,
    TAGAVE_UPDATE_FEED: `${UPDATER_URL}/releases`,
    EXPECT_WORKERS: '0',
  }, `app ${sha}`);
  const up = await waitFor(async () => {
    const r = await fetch(`${BASE_URL}/api/v1/version`);
    return r.ok && (await r.json()).sha === sha;
  }, { timeout: 30000 });
  if (!up) throw new Error(`app ${sha} did not come up:\n${app.log().slice(-3000)}`);
  return app;
}

const updater = {
  run: (status) => fetch(`${UPDATER_URL}/_test/run?status=${status}&target=0.7.7`, { method: 'POST' }),
  reset: () => fetch(`${UPDATER_URL}/_test/reset`, { method: 'POST' }),
};

async function createUser() {
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const [user] = await sql`insert into users (email, display_name, password_hash, role)
                           values (${email}, 'E2E reload', ${hash}, 'owner') returning id`;
  await sql`insert into auth_accounts (user_id, account_id, provider_id, password)
            values (${user.id}, ${user.id}::text, 'credential', ${hash})`;
  await sql`insert into libraries (owner_user_id, name, settings)
            values (${user.id}, 'E2E library', ${sql.json({ contactString: email, onboardingCompletedAt: new Date().toISOString() })})`;
  return user.id;
}

// --- the browser ---

/** The build a page runs: which build's index script it loaded (A's is gone from the server after the swap). */
const indexOf = (dist) => readdirSync(path.join(dist, 'assets')).find((f) => /^index-.*\.js$/.test(f));
async function pageBuild(page) {
  const src = await page.evaluate(() => [...document.querySelectorAll('script[type="module"][src]')].map((s) => s.getAttribute('src')).find((s) => s?.includes('/assets/index-')) ?? null);
  const file = src?.split('/').pop();
  return file === indexOf(DIST_A) ? SHA_A : file === indexOf(DIST_B) ? SHA_B : `other (${src})`;
}

/** Counts full page loads (a reload is one). */
function countLoads(page) {
  const counter = { n: 0 };
  page.on('load', () => { counter.n++; });
  return counter;
}

const notice = (page) => page.getByRole('status').filter({ hasText: 'tagave was updated.' });

let userId;
let browser;
let app;
let fake;
const contexts = [];
try {
  if (existsSync(webDist)) renameSync(webDist, webDistSaved);
  fake = startProcess(['e2e/fake-updater.mjs'], { PORT: String(UPDATER_PORT), RELEASES: '0.7.7', FROM: '0.7.6' }, 'fake updater');
  await waitFor(async () => (await fetch(`${UPDATER_URL}/v1/status`)).ok);
  await updater.reset();

  useWebBuild(DIST_A);
  app = await startApp(SHA_A, '0.7.6');
  userId = await createUser();
  step('build A up, throwaway owner created', true, email);

  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });

  // sign in once and share the session cookie
  const signIn = await browser.newContext({ baseURL: BASE_URL });
  const p0 = await signIn.newPage();
  await p0.goto('/login');
  await p0.getByLabel('Email').fill(email);
  await p0.locator('input#password').fill(password);
  await p0.getByRole('button', { name: 'Sign In', exact: true }).click();
  await p0.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  const { cookies } = await signIn.storageState();
  await signIn.close();

  async function openTab(pathname, { width = 1440, height = 900, colorScheme = 'light', blockStream = false } = {}) {
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width, height }, colorScheme, deviceScaleFactor: 2 });
    contexts.push(context);
    await context.addCookies(cookies);
    if (blockStream) await context.route('**/jobs/stream', (route) => route.abort());
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`  [page error ${pathname}] ${e.message}`));
    await page.goto(pathname);
    await page.locator('main#main-content').waitFor({ timeout: 15000 });
    return page;
  }

  // 1. every tab on build A
  const focusTab = await openTab('/', { blockStream: true });
  // a background check ran half a minute ago: the 5-minute one is not due, a focus check is
  await focusTab.evaluate(() => localStorage.setItem('tagave:build-checked-at', String(Date.now() - 31_000)));
  const focusLoads = countLoads(focusTab);
  const shotTabs = [];
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    for (const colorScheme of ['light', 'dark']) {
      shotTabs.push({ name: `notice-${colorScheme}-${width}`, page: await openTab('/', { width, height, colorScheme }) });
    }
  }
  const lazyTab = await openTab('/', { blockStream: true });
  const lazyLoads = countLoads(lazyTab);
  await updater.run('running');
  const updateTab = await openTab('/settings/updates', { blockStream: true });
  await updateTab.getByText('Updating to 0.7.7').first().waitFor({ timeout: 15000 });
  const updateLoads = countLoads(updateTab);
  step('tabs open on build A', (await pageBuild(focusTab)) === SHA_A && (await pageBuild(updateTab)) === SHA_A);
  step('no notice while the server runs the same build', (await notice(focusTab).count()) === 0);

  // the update: build B replaces build A, the app restarts
  await stopProcess(app);
  useWebBuild(DIST_B);
  app = await startApp(SHA_B, '0.7.7');
  const plansA = readdirSync(path.join(DIST_A, 'assets')).filter((f) => /^PlansPage-.*\.js$/.test(f));
  const plansB = readdirSync(path.join(webDist, 'assets')).filter((f) => /^PlansPage-.*\.js$/.test(f));
  const oldChunk = await fetch(`${BASE_URL}/assets/${plansA[0]}`);
  step('build B up, build A\'s page chunks gone (404)', plansA.length === 1 && !plansB.includes(plansA[0]) && oldChunk.status === 404, `${plansA[0]} → ${oldChunk.status}`);

  // 2. focus
  await sleep(1500);
  step('no notice before the tab gets focus', (await notice(focusTab).count()) === 0);
  await focusTab.evaluate(() => window.dispatchEvent(new Event('focus')));
  await notice(focusTab).waitFor({ timeout: 10000 });
  await focusTab.getByRole('button', { name: 'Reload', exact: true }).waitFor();
  await sleep(3000);
  step('focus → "tagave was updated." with Reload, and no reload by itself', focusLoads.n === 0 && (await pageBuild(focusTab)) === SHA_A);

  // 3. the job stream comes back after the restart
  for (const { name, page } of shotTabs) {
    await notice(page).waitFor({ timeout: 30000 });
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await sleep(400); // the slide-up
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    }
  }
  step('job stream reconnect → the note in every tab that follows it', true, SHOTS ? `screenshots in ${SHOTS}` : '');

  // Reload loads build B
  const shotPage = shotTabs[0].page;
  await shotPage.getByRole('button', { name: 'Reload', exact: true }).click();
  await shotPage.waitForLoadState('load');
  await shotPage.locator('main#main-content').waitFor({ timeout: 15000 });
  step('Reload loads build B, the note is gone', (await pageBuild(shotPage)) === SHA_B && (await notice(shotPage).count()) === 0);

  // 4. a lazy page of build A: a click without hovering first, so the router
  // fetches the chunk on navigation (a hover preloads it, which reloads the same way)
  await lazyTab.evaluate(() => document.querySelector('nav a[href="/plans"]')?.click());
  const reloaded = await waitFor(async () => lazyLoads.n >= 1, { timeout: 15000 });
  await lazyTab.getByRole('heading', { name: 'Tag changes' }).first().waitFor({ timeout: 15000 });
  await sleep(1500);
  step('lazy page of the old build → one reload into build B, page shown',
    !!reloaded && lazyLoads.n === 1 && new URL(lazyTab.url()).pathname === '/plans' && (await pageBuild(lazyTab)) === SHA_B,
    `loads=${lazyLoads.n} url=${lazyTab.url()}`);
  // the app's guarded reload did it (vite:preloadError), not only the router's own fallback
  step('…through the guarded reload', !!(await lazyTab.evaluate(() => sessionStorage.getItem('tagave:stale-reload-at'))));

  // 5. Settings › Updates: the run succeeds
  await updater.run('succeeded');
  await updateTab.getByText('Updated to 0.7.7').first().waitFor({ timeout: 15000 });
  const shownAt = Date.now();
  const updReloaded = await waitFor(async () => updateLoads.n >= 1, { timeout: 15000, every: 50 });
  const shownFor = Date.now() - shownAt;
  await updateTab.locator('main#main-content').waitFor({ timeout: 15000 });
  step('Updates: success shows ~2 s, then the tab reloads into build B',
    !!updReloaded && shownFor >= 1500 && updateLoads.n === 1 && (await pageBuild(updateTab)) === SHA_B,
    `shown for ${shownFor} ms`);
  await sleep(4000);
  step('…and stays put after the reload', updateLoads.n === 1 && (await updateTab.getByText('Updated to 0.7.7').count()) > 0);
} finally {
  for (const c of contexts) await c.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopProcess(app);
  await stopProcess(fake);
  if (userId) {
    await sql`delete from libraries where owner_user_id = ${userId}`.catch(() => undefined);
    await sql`delete from users where id = ${userId}`.catch((e) => console.log(`cleanup: ${e.message}`));
  }
  await sql.end();
  if (existsSync(webDistSaved)) {
    rmSync(webDist, { recursive: true, force: true });
    renameSync(webDistSaved, webDist);
  }
}
