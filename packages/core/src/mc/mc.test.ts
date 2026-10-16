/**
 * Music Connections client glue, without a network: tagave's defaults over
 * the package's rules (consumed capabilities, MC_TRUSTED_PUBLIC_HOSTS), the
 * manifest fetch, rfetch's test hooks over the pinned transport, and sealed
 * tokens. The rules themselves are tested in the music-connections package.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest } from 'music-connections';
import {
  LinkError,
  availableUngranted,
  endpointsOf,
  fetchRemoteManifest,
  linkScopes,
  mcUserAgent,
  openOne,
  openTokens,
  pinned,
  pullableCapabilities,
  remoteOrigin,
  revokeUrlFor,
  sealOne,
  sealTokens,
  setRemoteFetch,
  setResolver,
  resolveTarget,
  rfetch,
  isAllowedRemote,
  isAllowedRedirect,
} from './index.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sealSecret } from '../crypto/secretbox.js';

const RG = 'http://192.168.2.50:8080';
const SECRET = 'a'.repeat(64);

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    protocol: 'music-connections/1',
    service: 'review-gatherer',
    version: '0.4.0',
    auth: { authorize: '/connect/authorize', token: '/connect/token', register: '/connect/register' },
    provides: { 'critic-scores': '/mc/v1/critic-scores', identity: '/mc/v1/identity', 'wantlist-suggestions': '/mc/v1/wantlist-suggestions' },
    consumes: ['ratings', 'collection', 'listens', 'identity'],
    ...over,
  };
}

// no live DNS in these tests: a test that needs a name answered sets its own resolver
beforeEach(() => {
  setResolver(async (h) => { throw new Error(`no live DNS in tests (${h})`); });
});

afterEach(() => {
  setRemoteFetch(undefined);
  setResolver(undefined);
  delete process.env['MC_TRUSTED_PUBLIC_HOSTS'];
});

describe('scope derivation', () => {
  it('asks for what tagave consumes and the remote provides, write only with wantlist suggestions, offline_access last', () => {
    expect(linkScopes(manifest())).toEqual(['critic-scores:read', 'identity:read', 'wantlist-suggestions:read', 'wantlist-suggestions:write', 'offline_access']);
  });

  it('pulls only granted capabilities; the rest are available, re-link to grant', () => {
    const m = manifest();
    expect(pullableCapabilities(m, ['critic-scores:read'])).toEqual(['critic-scores']);
    expect(availableUngranted(m, ['critic-scores:read'])).toEqual(['identity', 'wantlist-suggestions']);
  });
});

describe('origin pinning (the package rules, tagave defaults)', () => {
  it('pins to the origin with MC_TRUSTED_PUBLIC_HOSTS as the trusted list', () => {
    expect(pinned('/connect/token', RG)).toBe(`${RG}/connect/token`);
    expect(() => pinned('http://192.168.2.51:8080/connect/token', RG)).toThrow(LinkError);
    expect(endpointsOf(manifest(), RG).feeds['critic-scores']).toBe(`${RG}/mc/v1/critic-scores`);
    expect(revokeUrlFor('/api/v1/connect/token', RG)).toBe(`${RG}/api/v1/connect/revoke`);
    expect(remoteOrigin('http://192.168.2.50:8080/some/page?x=1')).toBe(RG);
    expect(() => remoteOrigin('http://8.8.8.8')).toThrow('remote not allowed');
    // the provider's redirect gate stays narrower than the client's
    expect(isAllowedRemote('http://review-gatherer:3000/', [])).toBe(true);
    expect(isAllowedRedirect('http://review-gatherer:3000/', [])).toBe(false);
  });
});

describe('manifest fetch', () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const serve = (res: () => Response) => setRemoteFetch((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return res();
  }) as typeof fetch);
  afterEach(() => { calls.length = 0; });

  it('fetches the origin’s well-known manifest without redirects, with a timeout and the user agent', async () => {
    serve(() => Response.json(manifest()));
    const got = await fetchRemoteManifest('http://192.168.2.50:8080/settings');
    expect(got.origin).toBe(RG);
    expect(got.endpoints.register).toBe(`${RG}/connect/register`);
    expect(calls[0]!.url).toBe(`${RG}/.well-known/music-connections`);
    expect(calls[0]!.init?.redirect).toBe('manual');
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect((calls[0]!.init?.headers as Record<string, string>)['user-agent']).toBe(mcUserAgent());
    expect(mcUserAgent()).toMatch(/^tagave\/\S+ \(music-connections\/1\)$/);
  });

  it('refuses a manifest over 64 KB, by its length or by what arrives', async () => {
    const big = JSON.stringify({ ...manifest(), pad: 'x'.repeat(70_000) });
    serve(() => new Response(big, { headers: { 'content-length': String(big.length) } }));
    await expect(fetchRemoteManifest(RG)).rejects.toThrow('response too large');
    serve(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } })));
    await expect(fetchRemoteManifest(RG)).rejects.toThrow('response too large');
  });

  it('refuses non-JSON, an invalid manifest, an error status and a feed on another host', async () => {
    serve(() => new Response('<html>'));
    await expect(fetchRemoteManifest(RG)).rejects.toThrow('manifest not json');
    serve(() => Response.json({ protocol: 'other/1' }));
    await expect(fetchRemoteManifest(RG)).rejects.toThrow('manifest invalid');
    serve(() => new Response('', { status: 404 }));
    await expect(fetchRemoteManifest(RG)).rejects.toThrow('manifest HTTP 404');
    serve(() => Response.json(manifest({ provides: { 'critic-scores': 'http://10.9.9.9/feed' } })));
    await expect(fetchRemoteManifest(RG)).rejects.toThrow('endpoint on another host');
  });

  it('a network failure or a redirect reads as unreachable, never a remote body', async () => {
    setRemoteFetch((async () => { throw new TypeError('fetch failed: redirect'); }) as typeof fetch);
    await expect(fetchRemoteManifest(RG)).rejects.toThrow('remote unreachable');
  });

  it('a host off the allow-list, or a name resolving to a public address, is refused before any request', async () => {
    serve(() => Response.json(manifest()));
    setResolver(async () => ['93.184.216.34']);
    await expect(fetchRemoteManifest('http://example.com')).rejects.toThrow('address not allowed');
    await expect(fetchRemoteManifest('http://8.8.8.8')).rejects.toThrow('remote not allowed');
    expect(calls).toEqual([]);
  });
});

describe('sealed tokens', () => {
  const tokens = { access_token: 'mca_a', refresh_token: 'mcr_r', client_secret: 'mcs_s', access_expires_at: '2026-10-16T12:00:00.000Z' };

  it('round-trips, and the sealed value carries none of the secrets', () => {
    const sealed = sealTokens(tokens, SECRET);
    expect(sealed.startsWith('enc:v1:')).toBe(true);
    for (const v of Object.values(tokens).slice(0, 3)) expect(sealed).not.toContain(v);
    expect(openTokens(sealed, SECRET)).toEqual(tokens);
    expect(openOne(sealOne('mcs_s', SECRET), SECRET)).toBe('mcs_s');
  });

  it('a wrong APP_SECRET, plaintext or nothing opens to null', () => {
    expect(openTokens(sealTokens(tokens, SECRET), 'b'.repeat(64))).toBeNull();
    expect(openTokens(JSON.stringify(tokens), SECRET)).toBeNull();
    expect(openTokens('', SECRET)).toBeNull();
    expect(openTokens(sealSecret('{"access_token":""}', SECRET), SECRET)).toBeNull();
    expect(openOne('mcs_plain', SECRET)).toBeNull();
  });
});

describe('SSRF: resolved addresses', () => {
  it('a LAN name may reach private addresses only: not loopback, not public, not a mix', async () => {
    const answers: Record<string, string[]> = {
      'review-gatherer': ['192.168.2.50'],
      'sneaky.lan': ['127.0.0.1'],
      'mixed.lan': ['192.168.2.50', '93.184.216.34'],
      'public.example.com': ['93.184.216.34'],
      'meta.lan': ['169.254.169.254'],
    };
    setResolver(async (h) => answers[h] ?? []);
    await expect(resolveTarget('http://review-gatherer:3000/.well-known/music-connections')).resolves.toBe('192.168.2.50');
    await expect(resolveTarget('http://sneaky.lan/')).rejects.toThrow('address not allowed');
    await expect(resolveTarget('http://mixed.lan/')).rejects.toThrow('address not allowed');
    await expect(resolveTarget('https://public.example.com/')).rejects.toThrow('address not allowed');
    await expect(resolveTarget('http://meta.lan/')).rejects.toThrow('address not allowed');
    process.env['MC_TRUSTED_PUBLIC_HOSTS'] = 'public.example.com';
    await expect(resolveTarget('https://public.example.com/')).resolves.toBe('93.184.216.34');
    await expect(resolveTarget('http://public.example.com/')).rejects.toThrow('address not allowed');
  });

  it('a trusted name is resolved on every request and each answer checked (DNS rebinding)', async () => {
    process.env['MC_TRUSTED_PUBLIC_HOSTS'] = 'rg.example.com';
    const answers = [['93.184.216.34'], ['169.254.169.254'], ['93.184.216.34', '127.0.0.1'], ['::ffff:10.0.0.1'], []];
    const asked: string[] = [];
    setResolver(async (h) => { asked.push(h); return answers.shift()!; });
    await expect(resolveTarget('https://rg.example.com/.well-known/music-connections')).resolves.toBe('93.184.216.34');
    await expect(resolveTarget('https://rg.example.com/connect/token')).rejects.toThrow('address not allowed');
    await expect(resolveTarget('https://rg.example.com/mc/v1/identity')).rejects.toThrow('address not allowed');
    await expect(resolveTarget('https://rg.example.com/x')).resolves.toBe('::ffff:10.0.0.1');
    await expect(resolveTarget('https://rg.example.com/x')).rejects.toThrow('remote unresolvable');
    expect(asked).toHaveLength(5);
  });

  it('every request is checked, also with a test transport in place', async () => {
    const reached: string[] = [];
    setRemoteFetch(async (url) => { reached.push(url); return new Response('{}'); });
    await expect(rfetch('http://169.254.169.254/latest/meta-data')).rejects.toThrow('remote not allowed');
    await expect(rfetch('http://[::ffff:a9fe:a9fe]/')).rejects.toThrow('remote not allowed');
    await expect(rfetch('http://0.0.0.0:8080/')).rejects.toThrow('remote not allowed');
    expect(reached).toEqual([]);
  });

  it('a 3xx answer is an error, never followed', async () => {
    setRemoteFetch(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    await expect(rfetch(`${RG}/.well-known/music-connections`)).rejects.toThrow('redirect refused');
  });

  describe('over a real loopback socket', () => {
    let server: Server;
    let port = 0;
    const seen: Array<{ url: string; host: string | undefined; ua: string | undefined }> = [];
    beforeAllServer();
    function beforeAllServer() {
      it('starts', async () => {
        server = createServer((req, res) => {
          seen.push({ url: req.url ?? '', host: req.headers.host, ua: req.headers['user-agent'] });
          if (req.url === '/redirect') { res.writeHead(301, { location: 'http://169.254.169.254/' }); res.end(); return; }
          if (req.url === '/big') { res.writeHead(200); res.end('x'.repeat(100_000)); return; }
          if (req.url === '/slow') { setTimeout(() => res.end('{}'), 500); return; }
          if (req.url === '/broken') { res.writeHead(200, { 'content-length': '1000' }); res.write('{"pro'); setTimeout(() => res.destroy(), 20); return; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, method: req.method }));
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        port = (server.address() as AddressInfo).port;
      });
    }

    it('reaches a literal loopback host on the port the URL names, Host header kept', async () => {
      const res = await rfetch(`http://127.0.0.1:${port}/ping?x=1`, { method: 'POST', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect(await res.json()).toEqual({ ok: true, method: 'POST' });
      expect(seen.at(-1)).toEqual({ url: '/ping?x=1', host: `127.0.0.1:${port}`, ua: mcUserAgent() });
      // localhost resolves (here: to 127.0.0.1 only) and the connection goes to that address
      setResolver(async () => ['127.0.0.1']);
      const viaName = await rfetch(`http://localhost:${port}/ping`);
      expect(viaName.status).toBe(200);
      expect(seen.at(-1)!.host).toBe(`localhost:${port}`);
    });

    it('refuses a redirect, caps a body and times out', async () => {
      await expect(rfetch(`http://127.0.0.1:${port}/redirect`)).rejects.toThrow('redirect refused');
      const big = await rfetch(`http://127.0.0.1:${port}/big`);
      const { readCapped } = await import('./remote.js');
      await expect(readCapped(big, 64 * 1024)).rejects.toThrow('response too large');
      await expect(rfetch(`http://127.0.0.1:${port}/slow`, {}, { timeoutMs: 50 })).rejects.toThrow();
    });

    it('a body that breaks off after the headers is a LinkError, also for the manifest', async () => {
      const res = await rfetch(`http://127.0.0.1:${port}/broken`);
      const { readCapped, LinkError: LE } = await import('./remote.js');
      await expect(readCapped(res, 64 * 1024)).rejects.toBeInstanceOf(LE);
      setRemoteFetch(async (url, init) => {
        // the manifest path answers like /broken
        return fetch(url.replace('/.well-known/music-connections', '/broken'), init);
      });
      await expect(fetchRemoteManifest(`http://127.0.0.1:${port}`)).rejects.toBeInstanceOf(LE);
    });

    it('stops', async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
  });
});
