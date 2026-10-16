/**
 * Music Connections client helpers, without a network: scope derivation,
 * origin pinning and the allow-list on every manifest endpoint, the manifest
 * fetch's caps, and sealed tokens.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
} from './index.js';
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

afterEach(() => {
  setRemoteFetch(undefined);
  delete process.env['MC_TRUSTED_PUBLIC_HOSTS'];
});

describe('scope derivation', () => {
  it('asks for what tagave consumes and the remote provides, write only with wantlist suggestions, offline_access last', () => {
    expect(linkScopes(manifest())).toEqual(['critic-scores:read', 'identity:read', 'wantlist-suggestions:read', 'wantlist-suggestions:write', 'offline_access']);
  });

  it('no wantlist write without wantlist suggestions', () => {
    expect(linkScopes(manifest({ provides: { 'critic-scores': '/a', ratings: '/r' } }))).toEqual(['critic-scores:read', 'offline_access']);
  });

  it('never asks for what tagave provides itself (ratings, collection, listens)', () => {
    // a tagave on the other side provides ratings, collection, listens and identity: only identity is shared
    expect(linkScopes(manifest({ provides: { ratings: '/r', collection: '/c', listens: '/l', identity: '/i' } }))).toEqual(['identity:read', 'offline_access']);
  });

  it('nothing shared: no scopes at all (no lone offline_access)', () => {
    expect(linkScopes(manifest({ provides: { ratings: '/r' } }))).toEqual([]);
  });

  it('pulls only granted capabilities; the rest are available, re-link to grant', () => {
    const m = manifest();
    expect(pullableCapabilities(m, ['critic-scores:read'])).toEqual(['critic-scores']);
    expect(availableUngranted(m, ['critic-scores:read'])).toEqual(['identity', 'wantlist-suggestions']);
  });
});

describe('origin pinning and the allow-list', () => {
  it('a path or a same-origin URL resolves on the origin', () => {
    expect(pinned('/connect/token', RG)).toBe(`${RG}/connect/token`);
    expect(pinned(`${RG}/x`, RG)).toBe(`${RG}/x`);
  });

  it('refuses another host, another port and another scheme', () => {
    for (const u of ['http://192.168.2.51:8080/connect/token', 'http://192.168.2.50:9090/connect/token', 'https://192.168.2.50:8080/t', '//evil.example/t']) {
      expect(() => pinned(u, RG)).toThrow(LinkError);
    }
  });

  it('every feed in the manifest must sit on the origin, not only those tagave reads', () => {
    expect(() => endpointsOf(manifest({ provides: { 'critic-scores': '/a', ratings: 'http://10.0.0.9/mc/v1/ratings' } }), RG)).toThrow('endpoint on another host');
    expect(() => endpointsOf(manifest({ auth: { authorize: '/a', token: 'http://10.0.0.9/token', register: '/r' } }), RG)).toThrow(LinkError);
    expect(endpointsOf(manifest(), RG).feeds['critic-scores']).toBe(`${RG}/mc/v1/critic-scores`);
  });

  it('a remote base: private hosts over http, public ones only over https and when trusted', () => {
    expect(remoteOrigin('http://192.168.2.50:8080/some/page?x=1')).toBe(RG);
    expect(remoteOrigin('http://100.101.102.103')).toBe('http://100.101.102.103');
    expect(() => remoteOrigin('http://rg.example.com')).toThrow('remote not allowed');
    expect(() => remoteOrigin('https://rg.example.com')).toThrow('remote not allowed');
    process.env['MC_TRUSTED_PUBLIC_HOSTS'] = 'rg.example.com';
    expect(remoteOrigin('https://rg.example.com/')).toBe('https://rg.example.com');
    expect(() => remoteOrigin('http://rg.example.com')).toThrow('remote not allowed');
    expect(() => remoteOrigin('http://user:pw@192.168.2.50')).toThrow('invalid url');
    expect(() => remoteOrigin('ftp://192.168.2.50')).toThrow('invalid url');
    expect(() => remoteOrigin('not a url')).toThrow('invalid url');
    expect(() => remoteOrigin('http://8.8.8.8')).toThrow('remote not allowed');
  });

  it('the revoke endpoint sits next to the token endpoint, on the origin', () => {
    expect(revokeUrlFor('/api/v1/connect/token', RG)).toBe(`${RG}/api/v1/connect/revoke`);
    expect(revokeUrlFor('/oauth/exchange', RG)).toBeNull();
    expect(revokeUrlFor('http://10.0.0.9/token', RG)).toBeNull();
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
    expect(calls[0]!.init?.redirect).toBe('error');
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

  it('a host off the allow-list is refused before any request', async () => {
    serve(() => Response.json(manifest()));
    await expect(fetchRemoteManifest('http://example.com')).rejects.toThrow('remote not allowed');
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
