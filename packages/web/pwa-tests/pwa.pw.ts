import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type BrowserContext } from '@playwright/test';
import { launchChrome } from './cdp';

const DEV = 'http://127.0.0.1:4178';
const PREVIEW = 'http://127.0.0.1:4179';

/** A mono 16-bit WAV: `seconds` of a sine at `hz`. */
function wav(seconds: number, hz: number, rate = 22050): Buffer {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), 44 + i * 2);
  return buf;
}

const TRACK_SEC = 4;
const IDS = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];

function queueTrack(id: string, i: number) {
  return {
    localTrackId: id, discNo: 1, trackNo: i + 1, title: `Song ${i + 1}`, artist: 'Artist', album: 'Album', albumArtist: 'Artist', durationMs: TRACK_SEC * 1000,
    container: 'wav', codec: 'pcm', lossless: true, mime: 'audio/wav', available: true, reason: null,
    albumId: 'album-1', coverUrl: null, artists: [], year: null,
  };
}

/** The faked answer to a request: the player's API (tracks, a tone per stream, 200s for the queue and play events) and a bare page. */
function fakeAnswer(url: URL, audio: Buffer[]): { status: number; type: string; body: Buffer } {
  const json = (v: unknown) => ({ status: 200, type: 'application/json', body: Buffer.from(JSON.stringify(v)) });
  if (url.pathname === '/__player-test') return { status: 200, type: 'text/html', body: Buffer.from('<!doctype html><title>player</title>') };
  const stream = /\/player\/stream\/([^/?]+)/.exec(url.pathname);
  if (stream) return { status: 200, type: 'audio/wav', body: audio[IDS.indexOf(decodeURIComponent(stream[1]!))]! };
  if (url.pathname.endsWith('/player/tracks')) return json({ tracks: IDS.map(queueTrack) });
  if (url.pathname.endsWith('/me/player/queue/stamp')) return json({ deviceId: null, revision: 0 });
  if (url.pathname.endsWith('/me/player/queue')) return json({ revision: 1, updatedAt: new Date().toISOString() });
  return { status: 204, type: 'text/plain', body: Buffer.alloc(0) };
}

/** Runs in the page: plays the three tracks with the equalizer glow on and logs what happens. */
const START = `(async () => {
  const engine = await import('/src/player/engine.ts');
  const levels = await import('/src/adaptive/levels.ts');
  window.log = [];
  window.levels = [];
  engine.usePlayerStore.subscribe((s, prev) => {
    if (s.index !== prev.index || s.status !== prev.status) window.log.push({ index: s.index, status: s.status, visibility: document.visibilityState });
  });
  document.addEventListener('visibilitychange', () => window.log.push({ visibility: document.visibilityState }));
  await engine.playTracks(${JSON.stringify(IDS)}, { kind: 'playlist', id: 'p1', name: 'Test' });
  await new Promise((r) => setTimeout(r, 300));
  // the glow, as SeekGlow asks for it once something plays
  const node = await levels.playerAnalyser();
  window.glow = !!node;
  if (node) {
    const bins = new Uint8Array(node.frequencyBinCount);
    setInterval(() => { node.getByteFrequencyData(bins); window.levels.push(Math.max(...bins)); }, 200);
  }
  return true;
})()`;

test.describe('background playback', () => {
  test('with the tab hidden mid-track, the next track starts by itself (equalizer glow on)', async () => {
    test.setTimeout(60_000);
    const chrome = await launchChrome();
    try {
      const audio = IDS.map((_, i) => wav(TRACK_SEC, 330 + i * 110));
      const { targetId } = await chrome.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await chrome.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      chrome.on('Fetch.requestPaused', (p, sid) => {
        const request = p.request as { url: string };
        const answer = fakeAnswer(new URL(request.url), audio);
        void chrome.send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: answer.status, body: answer.body.toString('base64'),
          responseHeaders: [{ name: 'content-type', value: answer.type }, { name: 'content-length', value: String(answer.body.length) }],
        }, sid).catch(() => undefined);
      });
      await chrome.send('Fetch.enable', { patterns: [{ urlPattern: `${DEV}/api/*` }, { urlPattern: `${DEV}/__player-test` }] }, sessionId);
      await chrome.send('Page.enable', {}, sessionId);
      await chrome.send('Page.navigate', { url: `${DEV}/__player-test` }, sessionId);
      await expect.poll(() => chrome.evaluate(sessionId, 'document.readyState')).toBe('complete');
      await chrome.evaluate(sessionId, START);

      const log = () => chrome.evaluate<Array<{ index?: number; status?: string; visibility?: string }>>(sessionId, 'window.log');
      await expect.poll(async () => (await log()).some((e) => e.index === 0 && e.status === 'playing')).toBe(true);
      // the glow reads the music (from a copy: here the music never runs through Web Audio)
      expect(await chrome.evaluate(sessionId, 'window.glow')).toBe(true);
      await expect.poll(() => chrome.evaluate<number>(sessionId, 'Math.max(0, ...window.levels)')).toBeGreaterThan(0);

      // mid-track, another tab comes to the front of the window: this one is hidden
      await new Promise((r) => setTimeout(r, 1000));
      await chrome.send('Target.createTarget', { url: 'about:blank', newWindow: false });
      await expect.poll(() => chrome.evaluate(sessionId, 'document.visibilityState')).toBe('hidden');

      // two track ends later, still hidden: tracks 2 and 3 each started by themselves
      await new Promise((r) => setTimeout(r, TRACK_SEC * 2 * 1000 + 1500));
      const entries = await log();
      expect(await chrome.evaluate(sessionId, 'document.visibilityState')).toBe('hidden');
      const startedHidden = entries.filter((e) => e.status === 'playing' && e.visibility === 'hidden').map((e) => e.index);
      expect(startedHidden).toEqual(expect.arrayContaining([1, 2]));
      expect(await chrome.evaluate(sessionId, `import('/src/player/engine.ts').then((e) => e.usePlayerStore.getState().index)`)).toBe(2);
    } finally {
      await chrome.close();
    }
  });
});

/** A Chrome profile on disk: Chrome never offers to install from an incognito-like context. */
async function profile(launch: (dir: string) => Promise<BrowserContext>): Promise<{ context: BrowserContext; done: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'pwatest-profile-'));
  const context = await launch(dir);
  // the app's API is not running here: every call answers as signed out
  await context.route('**/api/**', (route) => route.fulfill({ status: 401, json: { status: 401, title: 'Unauthorized' } }));
  return { context, done: async () => { await context.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const chromeChannel = process.platform === 'linux' ? {} : { channel: 'chrome' as const };

test.describe('installable', () => {
  test('the manifest parses, the service worker controls the page, Chrome finds it installable, the shell opens offline', async ({ playwright }) => {
    const { context, done } = await profile((dir) => playwright.chromium.launchPersistentContext(dir, { ...chromeChannel, headless: true }));
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(`${PREVIEW}/`);
      const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
      expect(scope).toBe(`${PREVIEW}/`);
      await page.reload();
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

      const cdp = await context.newCDPSession(page);
      const manifest = await cdp.send('Page.getAppManifest') as { url: string; errors: Array<{ message: string }>; data?: string };
      expect(manifest.url).toBe(`${PREVIEW}/manifest.webmanifest`);
      expect(manifest.errors).toEqual([]);
      const data = JSON.parse(manifest.data ?? '{}') as { name?: string; display?: string; icons?: Array<{ purpose?: string }> };
      expect(data.name).toBe('tagave');
      expect(data.display).toBe('standalone');
      expect(data.icons?.some((i) => i.purpose === 'maskable')).toBe(true);
      const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors') as { installabilityErrors: Array<{ errorId: string }> };
      expect(installabilityErrors).toEqual([]);

      // what the worker kept: the shell and the entry files; never an API answer
      const cached = await page.evaluate(async () => {
        const urls: string[] = [];
        for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
        return urls;
      });
      expect(cached).toContain('/');
      expect(cached.some((u) => u.startsWith('/assets/index-'))).toBe(true);
      expect(cached.filter((u) => u.startsWith('/api/'))).toEqual([]);

      // offline, the app shell still opens
      await context.setOffline(true);
      await page.reload();
      expect(await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.getAttribute('href'))).toBe('/manifest.webmanifest');
      await expect(page.locator('#root > *').first()).toBeAttached();
      await context.setOffline(false);
    } finally {
      await done();
    }
  });

  test('beforeinstallprompt fires (Chrome, its engagement check bypassed)', async ({ playwright }) => {
    const { context, done } = await profile((dir) => playwright.chromium.launchPersistentContext(dir, { ...chromeChannel, headless: true, args: ['--bypass-app-banner-engagement-checks'] }));
    try {
      await context.addInitScript(() => {
        (window as unknown as { installPrompt: boolean }).installPrompt = false;
        window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); (window as unknown as { installPrompt: boolean }).installPrompt = true; });
      });
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(`${PREVIEW}/`);
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await page.reload();
      await expect.poll(() => page.evaluate(() => (window as unknown as { installPrompt: boolean }).installPrompt), { timeout: 15_000 }).toBe(true);
    } finally {
      await done();
    }
  });
});
