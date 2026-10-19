#!/usr/bin/env node
/**
 * People and roles, end to end, in real Chrome:
 *
 *   1. a fresh install's owner (made through first-run setup) invites a
 *      listener from Settings › Users and copies the one-time link;
 *   2. the listener opens it in a second browser, sets a name and password,
 *      skips the second factor and lands on Home;
 *   3. the listener's sidebar has Home, Albums, Artists, Physical collection
 *      and Settings but no Library care or Tag changes; Settings shows only
 *      Account, Appearance, Security and Listening; direct links to owner and editor
 *      pages show "Not available for your account"; the API refuses them;
 *   4. the owner makes the listener an editor; after a reload Library care
 *      and Tag changes appear for them and the pages open.
 *
 * With SHOTS=<dir> it also saves screenshots (1440 and 390 wide, light and
 * dark) of Settings › Users, the invite page, the listener's sidebar and the
 * "not available" page.
 *
 * Needs a running build on a database with no users yet (first-run setup
 * runs here), with PUBLIC_URL = BASE_URL and ALLOW_INSECURE_HTTP=true:
 *
 *   BASE_URL=http://localhost:3417 PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs \
 *   node e2e/users.e2e.mjs
 *
 * Never point it at a real install: it creates the owner account.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : 'playwright-core');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3417';
const SHOTS = process.env.SHOTS;
if (/prod|\.ts\.net|tagave\.(app|io)/i.test(BASE_URL)) throw new Error('refusing to run against what looks like production');

const owner = { email: 'owner@example.test', password: 'e2e owner password!', displayName: 'Ada Owner', contactString: 'owner@example.test' };
const listener = { email: 'listener@example.test', name: 'Sam Listener', password: 'e2e listener password!' };

let failed = false;
function step(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) { failed = true; throw new Error(`step failed: ${name} ${detail}`); }
}

const VIEWPORTS = [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844 }];
async function shoot(page, name, { openMenu = false } = {}) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  for (const vp of VIEWPORTS) {
    for (const scheme of ['light', 'dark']) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      if (openMenu && vp.width < 700) {
        const menu = page.getByRole('button', { name: /Open menu/ });
        if (await menu.isVisible().catch(() => false)) { await menu.click(); await page.waitForTimeout(250); }
      }
      await page.screenshot({ path: path.join(SHOTS, `${name}-${vp.name}-${scheme}.png`), fullPage: !openMenu });
      if (openMenu && vp.width < 700) {
        const close = page.getByRole('button', { name: 'Close menu' });
        if (await close.isVisible().catch(() => false)) await close.click();
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
}

const navNames = async (page) => (await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link').allInnerTexts()).map((t) => t.replace(/\d+.*$/s, '').trim());

const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), headless: process.env.HEADED !== '1' });
try {
  // ---- 1. the owner, through first-run setup, then Settings › Users ----
  const ownerCtx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
  const ownerPage = await ownerCtx.newPage();
  const setup = await ownerCtx.request.post('/api/v1/auth/setup', { data: owner, headers: { origin: BASE_URL } });
  step('first-run setup makes the owner', setup.status() === 201, `status ${setup.status()}`);
  const libraryId = (await (await ownerCtx.request.get('/api/v1/libraries')).json()).data[0].id;
  await ownerCtx.request.patch(`/api/v1/libraries/${libraryId}/settings`, { data: { onboardingCompletedAt: new Date().toISOString() }, headers: { origin: BASE_URL } });

  await ownerPage.goto('/settings/users');
  await ownerPage.getByRole('heading', { name: 'People' }).waitFor();
  step('Settings › Users lists the owner', await ownerPage.getByText('Ada Owner').isVisible());
  await ownerPage.getByLabel(/^Email/).fill(listener.email);
  await ownerPage.getByLabel('Role', { exact: true }).selectOption('listener');
  await ownerPage.getByRole('button', { name: 'Invite', exact: true }).click();
  const linkBox = ownerPage.getByLabel('One-time link');
  await linkBox.waitFor();
  const link = await linkBox.inputValue();
  step('the invite link is shown once, to copy', /\/invite\/[A-Za-z0-9_-]{30,}$/.test(link), link.replace(/[A-Za-z0-9_-]{30,}$/, '<token>'));
  await ownerPage.getByRole('button', { name: 'Done' }).click();
  await ownerPage.getByRole('heading', { name: 'Open links' }).waitFor();
  await shoot(ownerPage, 'settings-users');

  // ---- 2. the listener accepts in a second browser ----
  const listenerCtx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
  const lp = await listenerCtx.newPage();
  await lp.goto(link);
  await lp.getByRole('heading', { name: 'Create your account' }).waitFor();
  step('the invite page names the role', await lp.getByText('You are invited as a listener').isVisible());
  await shoot(lp, 'invite-accept');
  const fields = lp.locator('input[autocomplete="new-password"]');
  await lp.getByLabel(/^Name/).fill(listener.name);
  await fields.nth(0).fill(listener.password);
  await fields.nth(1).fill(listener.password);
  await lp.getByRole('button', { name: 'Create account' }).click();
  await lp.getByRole('heading', { name: 'Protect your account' }).waitFor();
  step('after the invite: the second-factor step, without the setup steps', !(await lp.getByRole('navigation', { name: 'Setup progress' }).isVisible().catch(() => false)));
  await lp.getByRole('button', { name: 'Skip for now' }).click();
  await lp.getByRole('heading', { name: 'Home' }).waitFor();
  step('the listener lands on Home', new URL(lp.url()).pathname === '/');

  // ---- 3. what a listener sees and is refused ----
  const nav = await navNames(lp);
  step('listener sidebar: Home, Albums, Artists, Physical collection, Settings', ['Home', 'Albums', 'Artists', 'Physical collection', 'Settings'].every((n) => nav.includes(n)), nav.join(', '));
  step('listener sidebar: no Library care, no Tag changes', !nav.includes('Library care') && !nav.includes('Tag changes'));
  step('Home has no library care for a listener', !(await lp.getByRole('heading', { name: 'Care for your library' }).isVisible().catch(() => false)));
  await shoot(lp, 'listener-sidebar', { openMenu: true });

  await lp.goto('/settings');
  await lp.getByRole('navigation', { name: 'Settings sections' }).waitFor();
  const sections = await lp.getByRole('navigation', { name: 'Settings sections' }).getByRole('link').allInnerTexts();
  step('listener Settings: Account, Appearance, Security, Listening only', JSON.stringify(sections) === JSON.stringify(['Account', 'Appearance', 'Security', 'Listening']), sections.join(', '));

  for (const url of ['/plans', '/work', '/settings/backups', '/settings/users', '/settings/playback', '/settings/library', '/onboarding']) {
    await lp.goto(url);
    await lp.getByRole('heading', { name: 'Not available for your account' }).waitFor({ timeout: 10_000 }).catch(() => undefined);
    step(`direct link ${url}: "Not available for your account"`, await lp.getByRole('heading', { name: 'Not available for your account' }).isVisible());
  }
  await lp.goto('/plans');
  await lp.getByRole('heading', { name: 'Not available for your account' }).waitFor();
  await shoot(lp, 'not-available');

  for (const [method, url] of [
    ['GET', '/api/v1/users'],
    ['GET', `/api/v1/libraries/${libraryId}/tag-plans`],
    ['GET', `/api/v1/libraries/${libraryId}/queue`],
    ['POST', `/api/v1/libraries/${libraryId}/albums/bulk`],
    ['GET', '/api/v1/backups'],
    ['PATCH', `/api/v1/libraries/${libraryId}/settings`],
  ]) {
    const res = await listenerCtx.request.fetch(url, { method, headers: { origin: BASE_URL }, ...(method === 'GET' ? {} : { data: {} }) });
    step(`API refuses the listener: ${method} ${url.replace(libraryId, ':id')}`, res.status() === 403, `status ${res.status()}`);
  }
  for (const url of ['/api/v1/libraries', `/api/v1/libraries/${libraryId}/albums`, `/api/v1/libraries/${libraryId}/artists`, '/api/v1/capabilities']) {
    const res = await listenerCtx.request.get(url);
    step(`API serves the listener: GET ${url.replace(libraryId, ':id')}`, res.status() === 200, `status ${res.status()}`);
  }

  // ---- 4. the owner makes them an editor ----
  await ownerPage.goto('/settings/users');
  await ownerPage.getByLabel(`Role for ${listener.name}`).selectOption('editor');
  await ownerPage.getByRole('button', { name: 'Make editor' }).click();
  await ownerPage.waitForResponse((r) => r.url().endsWith('/api/v1/users') && r.request().method() === 'GET');
  step('Settings › Users shows the new role', (await ownerPage.getByLabel(`Role for ${listener.name}`).inputValue()) === 'editor');
  await shoot(ownerPage, 'settings-users-people');

  await lp.goto('/');
  await lp.getByRole('heading', { name: 'Home' }).waitFor();
  await lp.waitForTimeout(500);
  const navAfter = await navNames(lp);
  step('as an editor: Library care and Tag changes appear', navAfter.includes('Library care') && navAfter.includes('Tag changes'), navAfter.join(', '));
  await lp.goto('/plans');
  await lp.waitForTimeout(800);
  step('as an editor: Tag changes opens', !(await lp.getByRole('heading', { name: 'Not available for your account' }).isVisible().catch(() => false)));
  await lp.goto('/work');
  await lp.waitForTimeout(800);
  step('as an editor: Library care opens', !(await lp.getByRole('heading', { name: 'Not available for your account' }).isVisible().catch(() => false)));
  await lp.goto('/settings/backups');
  await lp.getByRole('heading', { name: 'Not available for your account' }).waitFor();
  step('as an editor: Backups stays the owner\'s', true);
  if (SHOTS) {
    await lp.goto('/');
    await lp.getByRole('heading', { name: 'Home' }).waitFor();
    await shoot(lp, 'editor-sidebar', { openMenu: true });
  }

  await listenerCtx.close();
  await ownerCtx.close();
} finally {
  await browser.close();
}
console.log(failed ? 'users e2e FAILED' : 'users e2e passed');
process.exit(failed ? 1 : 0);
