import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORWARDED_SEEN_FILE, FORWARDED_SEEN_MIN, checkForwardedHeaders, createForwardedObserver } from './proxyCheck.js';
import { remediationFor } from './remediation.js';

describe('reverse proxy check', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tagave-proxy-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const send = async (observe: ReturnType<typeof createForwardedObserver>, peer: string, ip: string, n = FORWARDED_SEEN_MIN) => {
    for (let i = 0; i < n; i++) await observe(peer, ip, true);
  };

  it('passes, silently, with nothing seen', async () => {
    expect(await checkForwardedHeaders(dir, {})).toMatchObject({ id: 'forwardedHeaders', status: 'pass', detail: 'TRUST_PROXY unset: proxies on private networks' });
    expect(await checkForwardedHeaders(dir, { TRUST_PROXY: '1' })).toMatchObject({ status: 'pass', detail: 'TRUST_PROXY=1' });
  });

  it('notes nothing when the header was used, or never sent', async () => {
    const observe = createForwardedObserver({ cacheDir: dir, trustProxyRaw: '' });
    await send(observe, '172.18.0.5', '198.51.100.7', 20); // a proxy on the Docker network: request.ip came from the header
    for (let i = 0; i < 20; i++) await observe('203.0.113.9', '203.0.113.9', false);
    await expect(readFile(join(dir, FORWARDED_SEEN_FILE), 'utf8')).rejects.toThrow();
    expect((await checkForwardedHeaders(dir, {})).status).toBe('pass');
  });

  it('warns about a proxy on a public address, with the setting that fixes it', async () => {
    const observe = createForwardedObserver({ cacheDir: dir, trustProxyRaw: '' });
    await send(observe, '203.0.113.9', '203.0.113.9', FORWARDED_SEEN_MIN - 1);
    expect((await checkForwardedHeaders(dir, {})).status).toBe('pass'); // a stray probe is not a proxy
    await send(observe, '::ffff:203.0.113.9', '::ffff:203.0.113.9', 1);
    const check = await checkForwardedHeaders(dir, {});
    expect(check).toMatchObject({ status: 'warn', detail: 'X-Forwarded-For from 203.0.113.9 ignored: not a private address. Visitors share its rate limits.' });
    expect(remediationFor(check)).toMatch(/set TRUST_PROXY=203\.0\.113\.9/);
  });

  it('names a proxy missing from an explicit list (the Docker gateway under TRUST_PROXY=172.21.0.0/16)', async () => {
    const observe = createForwardedObserver({ cacheDir: dir, trustProxyRaw: '172.21.0.0/16' });
    await send(observe, '192.168.80.1', '192.168.80.1');
    const check = await checkForwardedHeaders(dir, { TRUST_PROXY: '172.21.0.0/16' });
    expect(check.detail).toMatch(/^X-Forwarded-For from 192\.168\.80\.1 ignored: not in TRUST_PROXY/);
    expect(check.detail).toMatch(/not in TRUST_PROXY/);
    expect(remediationFor(check)).toMatch(/add it to TRUST_PROXY/);
  });

  it('says nothing under TRUST_PROXY=off, after the setting changed, or about an old sighting', async () => {
    const off = createForwardedObserver({ cacheDir: dir, trustProxyRaw: 'off' });
    await send(off, '203.0.113.9', '203.0.113.9', 20);
    expect((await checkForwardedHeaders(dir, { TRUST_PROXY: 'off' })).status).toBe('pass');

    const observe = createForwardedObserver({ cacheDir: dir, trustProxyRaw: '' });
    await send(observe, '203.0.113.9', '203.0.113.9');
    expect((await checkForwardedHeaders(dir, { TRUST_PROXY: '203.0.113.9' })).status).toBe('pass');
    expect((await checkForwardedHeaders(dir, {}, Date.now() + 8 * 24 * 60 * 60 * 1000)).status).toBe('pass');
    await writeFile(join(dir, FORWARDED_SEEN_FILE), 'not json');
    expect((await checkForwardedHeaders(dir, {})).status).toBe('pass');
  });
});
