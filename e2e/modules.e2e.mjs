#!/usr/bin/env node
/**
 * Settings › Modules end to end, in real Chrome, against a real install
 * with the in-app updater and a locally signed test release (its catalogue
 * holds the player plus test-only modules "dummy" and "broken"):
 *
 *   1. the list, from the signed catalogue;
 *   2. Turn on Dummy: progress step by step, then on (its container runs);
 *   3. Turn on Player: the app restarts with TAGAVE_PLAYER_URL, Navidrome
 *      reports healthy, Settings › Playback says connected;
 *   4. Turn off Player keeping its data (the volume stays);
 *   5. Turn on Broken: it does not come up, the updater rolls back, the page
 *      says why and that everything is as it was;
 *   6. Turn off Dummy deleting its data (the volume goes);
 *   7. the install's release-manifest.json changed on disk: the page refuses
 *      every module with the signature reason, and so does the API;
 *   8. without the updater (TAGAVE_UPDATER_URL cleared): the commands.
 *
 * No shell step is needed for 2–6: everything happens through the page.
 * Screenshots of each state at 1440 and 390 px, light and dark, go to SHOTS.
 *
 *   BASE_URL=http://localhost:55460 INSTALL_DIR=$HOME/.r2ce2e EMAIL=… PASSWORD=… \
 *   ASSETS_URL=http://r2ce2e-assets:8080 SHOTS=/tmp/shots PLAYWRIGHT_CORE=…/playwright-core/index.mjs \
 *   node e2e/modules.e2e.mjs
 *
 * It changes the install it is pointed at: use a throwaway one.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : 'playwright-core');
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:55460';
const INSTALL_DIR = process.env.INSTALL_DIR;
const SHOTS = process.env.SHOTS ?? '/tmp/tagave-modules-shots';
const { EMAIL, PASSWORD } = process.env;
if (!INSTALL_DIR || !EMAIL || !PASSWORD) throw new Error('INSTALL_DIR, EMAIL and PASSWORD are required');
if (/prod|\.ts\.net/i.test(BASE_URL)) throw new Error('refusing to run against what looks like production');
mkdirSync(SHOTS, { recursive: true });
// FROM=7 starts at step 7 (the steps before leave the install as they found it).
const FROM = Number(process.env.FROM ?? 1);
const want = (n) => n >= FROM;
const ASSETS_DIR = process.env.ASSETS_DIR;
// Files this run changes go back as they were, also when a check fails.
const restores = [];
process.on('exit', () => { for (const r of restores.reverse()) { try { r(); } catch { /* best effort */ } } });

const compose = (...args) => execFileSync('docker', ['compose', ...args], { cwd: INSTALL_DIR, encoding: 'utf8' }).trim();
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const project = readFileSync(path.join(INSTALL_DIR, '.env'), 'utf8').match(/^COMPOSE_PROJECT_NAME=(.*)$/m)?.[1] ?? 'tagave';
const volumes = () => docker('volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`).split('\n');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name} ${detail}`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const VARIANTS = [
  { name: '1440-light', width: 1440, height: 1000, theme: 'light' },
  { name: '1440-dark', width: 1440, height: 1000, theme: 'dark' },
  { name: '390-light', width: 390, height: 844, theme: 'light' },
  { name: '390-dark', width: 390, height: 844, theme: 'dark' },
];
async function context(theme, width, height, storageState) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, ...(storageState ? { storageState } : {}) });
  await ctx.addInitScript((t) => { try { localStorage.setItem('tagave-theme', t); } catch { /* no storage */ } }, theme);
  return ctx;
}

// Sign in once; every variant shares the session.
const main = await context('light', 1440, 1000);
const login = await main.request.post(`${BASE_URL}/api/v1/auth/login`, { data: { email: EMAIL, password: PASSWORD }, headers: { origin: BASE_URL } });
check('signs in', login.ok(), `${login.status()}`);
const state = await main.storageState();
const pages = [];
for (const v of VARIANTS) {
  const ctx = v.name === '1440-light' ? main : await context(v.theme, v.width, v.height, state);
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/settings/modules`);
  pages.push({ v, page });
}
const page = pages[0].page;

async function shots(label) {
  for (const { v, page: p } of pages) {
    if (p !== page) await p.reload();
    await p.getByRole('heading', { name: 'Modules', exact: true }).waitFor();
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(SHOTS, `modules-${label}-${v.name}.png`), fullPage: true });
  }
}
const row = (name) => page.locator('li', { has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) });
async function confirm(label, tickDelete = false) {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  if (tickDelete) await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: label, exact: true }).click();
}
const done = () => page.getByRole('button', { name: 'Done', exact: true }).click();
const service = (name) => docker('ps', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${name}`, '--format', '{{.Status}}');

// A finished run from an earlier session stays on screen until dismissed.
for (const { page: p } of pages) {
  const old = p.getByRole('button', { name: 'Done', exact: true });
  if (await old.isVisible().catch(() => false)) await old.click();
}

// 1. the list
await page.getByText('Plays your albums in tagave').first().waitFor();
check('lists the catalogue', (await page.locator('li h3').allInnerTexts()).join(',') === 'Player,Dummy,Broken dummy');
await shots('list');

// 2. Dummy on
if (want(2)) {
await row('Dummy').getByRole('button', { name: 'Turn on' }).click();
await confirm('Turn on');
await page.getByText('Turning on Dummy').first().waitFor();
await shots('turning-on');
await page.getByText('Dummy is on').first().waitFor({ timeout: 300_000 });
check('Dummy is on, its container runs', /^Up/.test(service('dummy')), service('dummy'));
await shots('on');
await done();

// 3. Player on (the app restarts)
await row('Player').getByRole('button', { name: 'Turn on' }).click();
await confirm('Turn on');
await page.getByText('Player is on').first().waitFor({ timeout: 600_000 });
check('the player reports healthy', /healthy/.test(service('player')), service('player'));
await done();
await page.goto(`${BASE_URL}/settings/playback`);
await page.getByText('Connected').first().waitFor({ timeout: 60_000 });
check('Settings › Playback says connected', true);
await page.goto(`${BASE_URL}/settings/modules`);

// 4. Player off, data kept
await row('Player').getByRole('button', { name: 'Turn off' }).click();
await confirm('Turn off');
await page.getByText('Player is off').first().waitFor({ timeout: 600_000 });
check('the player is gone, its volume kept', service('player') === '' && volumes().includes(`${project}_player-data`));
await page.getByText('Its data is kept.').first().waitFor();
await done();

// 5. Broken: fails and rolls back
await row('Broken dummy').getByRole('button', { name: 'Turn on' }).click();
await confirm('Turn on');
await page.getByText('Turning on Broken dummy failed; everything is as it was').first().waitFor({ timeout: 600_000 });
const env = readFileSync(path.join(INSTALL_DIR, '.env'), 'utf8');
check('a failed Turn on leaves .env as it was', !/COMPOSE_PROFILES=.*broken/.test(env) && !/modules\/broken\.yml/.test(env));
await shots('failed');
await done();

// 6. Dummy off, data deleted
await row('Dummy').getByRole('button', { name: 'Turn off' }).click();
await confirm('Turn off', true);
await page.getByText('Dummy is off').first().waitFor({ timeout: 300_000 });
check('Dummy is gone with its volume', service('dummy') === '' && !volumes().includes(`${project}_dummy-data`));
await done();

}

// 7. a changed manifest: on disk only, the app brings the signed one again;
// changed where it is downloaded from too, every module is refused.
const manifestPath = path.join(INSTALL_DIR, 'release-manifest.json');
const original = readFileSync(manifestPath, 'utf8');
const tampered = original.replace('"purpose": "Plays your albums', '"purpose": "Plays all your albums');
writeFileSync(manifestPath, tampered);
await page.reload();
await page.locator('li h3').first().waitFor();
check('a manifest changed on disk is replaced by the signed one', readFileSync(manifestPath, 'utf8') === original);
const servedPath = ASSETS_DIR ? path.join(ASSETS_DIR, 'v0.9.2', 'release-manifest.json') : null;
const served = servedPath ? readFileSync(servedPath, 'utf8') : null;
restores.push(() => { writeFileSync(manifestPath, original); if (servedPath) writeFileSync(servedPath, served); });
if (servedPath) writeFileSync(servedPath, tampered);
writeFileSync(manifestPath, tampered);
// the app keeps downloaded release files for ten minutes: start it afresh
compose('restart', 'app');
for (let i = 0; i < 60 && !/healthy/.test(service('app')); i += 1) await new Promise((r) => setTimeout(r, 3000));
await page.reload();
await page.getByText(/No module can be turned on: .*changed after tagave signed it/).first().waitFor({ timeout: 60_000 });
const refused = await main.request.post(`${BASE_URL}/api/v1/modules/dummy/enable`, { data: {}, headers: { origin: BASE_URL } });
const body = await refused.json();
check('a tampered manifest is refused by the API too', refused.status() === 422 && /does not match its signature/.test(body.detail), `${refused.status()} ${body.detail}`);
await shots('tampered');
writeFileSync(manifestPath, original);
if (servedPath) writeFileSync(servedPath, served);

// 8. no updater: the commands
const envPath = path.join(INSTALL_DIR, '.env');
const envText = readFileSync(envPath, 'utf8');
restores.push(() => { writeFileSync(envPath, envText); compose('up', '-d', 'app'); });
writeFileSync(envPath, envText.replace(/^TAGAVE_UPDATER_URL=.*$/m, 'TAGAVE_UPDATER_URL=').replace(/^TAGAVE_RELEASE_ASSETS_URL=.*$/m, '') + `TAGAVE_RELEASE_ASSETS_URL=${process.env.ASSETS_URL ?? ''}\n`);
compose('up', '-d', 'app');
for (let i = 0; i < 60 && !/healthy/.test(service('app')); i += 1) await new Promise((r) => setTimeout(r, 3000));
await page.goto(`${BASE_URL}/settings/modules`);
await page.getByText('./install-tagave.sh enable-module player').first().waitFor({ timeout: 60_000 });
check('without the updater the page shows the commands', (await page.locator('button', { hasText: 'Turn on' }).count()) === 0);
await shots('no-updater');
writeFileSync(envPath, envText);
compose('up', '-d', 'app');

await browser.close();
console.log(`\n${results.length} checks passed; screenshots in ${SHOTS}`);
