import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  OidcConfigError,
  authTimeFresh,
  discoverOidc,
  discoveryUrlFor,
  groupsOf,
  hasLocalWayIn,
  inJoinGroup,
  parseIssuerInput,
  oidcAccountKey,
  profileFromTokens,
  serviceFetch,
  withoutOidcTokens,
} from './oidc.js';

const doc = (over: Record<string, unknown> = {}) => ({
  issuer: 'https://login.example.com',
  authorization_endpoint: 'https://login.example.com/oauth/v2/authorize',
  token_endpoint: 'https://login.example.com/oauth/v2/token',
  userinfo_endpoint: 'https://login.example.com/oidc/v1/userinfo',
  jwks_uri: 'https://login.example.com/oauth/v2/keys',
  response_types_supported: ['code', 'id_token'],
  id_token_signing_alg_values_supported: ['RS256'],
  code_challenge_methods_supported: ['S256'],
  ...over,
});

const fetchOf = (body: unknown, status = 200) =>
  (async (url: string | URL | Request) => {
    expect(String(url)).toMatch(/\/\.well-known\/openid-configuration$/);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('issuer input', () => {
  it('takes https, and http only on this computer', () => {
    expect(parseIssuerInput(' https://login.example.com ').hostname).toBe('login.example.com');
    expect(parseIssuerInput('http://localhost:5556/dex').pathname).toBe('/dex');
    expect(parseIssuerInput('http://127.0.0.1:8080').port).toBe('8080');
    expect(() => parseIssuerInput('http://login.lan')).toThrow(OidcConfigError);
    expect(() => parseIssuerInput('https://login.example.com/?x=1')).toThrow(/query/);
    expect(() => parseIssuerInput('not a url')).toThrow(/not a URL/);
  });

  it('finds the discovery document under the issuer, slash or not', () => {
    expect(discoveryUrlFor('https://ak.example/application/o/tagave/')).toBe('https://ak.example/application/o/tagave/.well-known/openid-configuration');
    expect(discoveryUrlFor('https://kc.example/realms/home')).toBe('https://kc.example/realms/home/.well-known/openid-configuration');
  });
});

describe('discovery', () => {
  it('keeps the issuer as the document spells it', async () => {
    const d = await discoverOidc('https://login.example.com/', fetchOf(doc()));
    expect(d).toMatchObject({ issuer: 'https://login.example.com', pkceS256: true, userinfoEndpoint: 'https://login.example.com/oidc/v1/userinfo' });
  });

  it('refuses a document that names another issuer', async () => {
    await expect(discoverOidc('https://login.example.com', fetchOf(doc({ issuer: 'https://evil.example' })))).rejects.toThrow(/another issuer/);
    await expect(discoverOidc('https://login.example.com', fetchOf(doc({ issuer: undefined })))).rejects.toThrow(/another issuer/);
  });

  it('wants https endpoints (plain http only on this computer) and follows no redirect', async () => {
    for (const key of ['token_endpoint', 'jwks_uri', 'userinfo_endpoint', 'authorization_endpoint']) {
      await expect(discoverOidc('https://login.example.com', fetchOf(doc({ [key]: 'http://login.example.com/x' })))).rejects.toThrow(/must be https/);
    }
    const local = { issuer: 'http://127.0.0.1:5556/dex', authorization_endpoint: 'http://127.0.0.1:5556/dex/auth', token_endpoint: 'http://127.0.0.1:5556/dex/token', jwks_uri: 'http://127.0.0.1:5556/dex/keys' };
    expect((await discoverOidc('http://127.0.0.1:5556/dex', fetchOf(doc(local)))).tokenEndpoint).toBe('http://127.0.0.1:5556/dex/token');
    let init: RequestInit | undefined;
    const moved = (async (_url: string | URL | Request, i?: RequestInit) => {
      init = i;
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/.well-known/openid-configuration' } });
    }) as typeof fetch;
    await expect(discoverOidc('https://login.example.com', moved)).rejects.toThrow(/redirected/);
    expect(init?.redirect).toBe('manual');
  });

  it('refuses plain OAuth (no signed id_tokens), no keys, no code flow, errors', async () => {
    await expect(discoverOidc('https://login.example.com', fetchOf(doc({ id_token_signing_alg_values_supported: [] })))).rejects.toThrow(/not OpenID Connect/);
    await expect(discoverOidc('https://login.example.com', fetchOf(doc({ jwks_uri: undefined })))).rejects.toThrow(/jwks_uri/);
    await expect(discoverOidc('https://login.example.com', fetchOf(doc({ response_types_supported: ['token'] })))).rejects.toThrow(/code flow/);
    await expect(discoverOidc('https://login.example.com', fetchOf({}, 404))).rejects.toThrow(/404/);
    const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    await expect(discoverOidc('https://login.example.com', down)).rejects.toThrow(/Could not reach/);
  });
});

describe('groups', () => {
  it('reads the groups claim and Zitadel project roles', () => {
    expect(groupsOf({ groups: ['music', 'family', 3] })).toEqual(['music', 'family']);
    expect(groupsOf({ 'urn:zitadel:iam:org:project:roles': { music: { '1': 'org' } } })).toEqual(['music']);
    expect(groupsOf({ 'urn:zitadel:iam:org:project:2849:roles': { listeners: {} } })).toEqual(['listeners']);
    expect(groupsOf({})).toEqual([]);
  });

  it('no group set: anyone; set: only members', () => {
    expect(inJoinGroup({}, null)).toBe(true);
    expect(inJoinGroup({ groups: ['family'] }, 'music')).toBe(false);
    expect(inJoinGroup({ groups: ['music'] }, 'music')).toBe(true);
    expect(inJoinGroup({ groups: 'music' }, 'music')).toBe(true);
  });
});

describe('step-up freshness', () => {
  const started = Date.UTC(2026, 10, 2, 12, 0, 0);
  it('counts an auth_time after the request (minus skew), not before, and never a missing one', () => {
    expect(authTimeFresh(started / 1000 + 20, started, started + 30_000)).toBe(true);
    expect(authTimeFresh(started / 1000 - 30, started, started + 30_000)).toBe(true);
    expect(authTimeFresh(started / 1000 - 3600, started, started + 30_000)).toBe(false);
    expect(authTimeFresh(started / 1000 + 3600, started, started + 30_000)).toBe(false);
    expect(authTimeFresh(undefined, started)).toBe(false);
    expect(authTimeFresh('1700000000', started)).toBe(false);
    expect(authTimeFresh(started / 1000, undefined)).toBe(false);
  });
});

describe('profile from tokens', () => {
  const iss = 'https://login.example.com';
  it('needs an id_token from the issuer that was set', async () => {
    expect(await profileFromTokens({ accessToken: 'a' }, iss, null)).toBeNull();
    expect(await profileFromTokens({ idToken: jwt({ iss: 'https://evil.example', sub: '1' }) }, iss, null)).toBeNull();
    expect(await profileFromTokens({ idToken: jwt({ iss, sub: '' }) }, iss, null)).toBeNull();
  });

  it('fills email and name from userinfo for the same sub only', async () => {
    const userinfo = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const same = await profileFromTokens({ idToken: jwt({ iss, sub: 'u1', auth_time: 5 }), accessToken: 'at' }, iss, 'https://login.example.com/userinfo', userinfo({ sub: 'u1', email: 'a@b.c', name: 'A' }));
    expect(same).toMatchObject({ id: 'u1', sub: 'u1', email: 'a@b.c', name: 'A', auth_time: 5, emailVerified: false });
    const other = await profileFromTokens({ idToken: jwt({ iss, sub: 'u1' }), accessToken: 'at' }, iss, 'https://login.example.com/userinfo', userinfo({ sub: 'u2', email: 'x@y.z' }));
    expect(other?.email).toBeUndefined();
  });

  it('takes groups from userinfo when the id_token has none (Authelia)', async () => {
    const userinfo = (async () => new Response(JSON.stringify({ sub: 'u1', groups: ['music'] }))) as unknown as typeof fetch;
    const p = await profileFromTokens({ idToken: jwt({ iss, sub: 'u1', email: 'a@b.c', name: 'A' }), accessToken: 'at' }, iss, 'https://x/userinfo', userinfo);
    expect(p?.['groups']).toEqual(['music']);
  });

  it('the id_token wins over userinfo', async () => {
    const userinfo = (async () => new Response(JSON.stringify({ sub: 'u1', iss: 'https://evil.example', name: 'Info' }))) as unknown as typeof fetch;
    const p = await profileFromTokens({ idToken: jwt({ iss, sub: 'u1', email: 'a@b.c', email_verified: true }), accessToken: 'at' }, iss, 'https://x/userinfo', userinfo);
    expect(p).toMatchObject({ iss, email: 'a@b.c', emailVerified: true, name: 'Info' });
  });
});

describe('accounts', () => {
  it('drops the service tokens before an oidc account is written, and leaves others alone', () => {
    expect(withoutOidcTokens({ providerId: 'oidc', accessToken: 'a', refreshToken: 'r', idToken: 'i' })?.data).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
    expect(withoutOidcTokens({ providerId: 'credential', password: 'h' })).toBeUndefined();
  });

  it('a local way in is a password or a passkey', () => {
    expect(hasLocalWayIn({ password: false, passkeys: 0, oidc: true })).toBe(false);
    expect(hasLocalWayIn({ password: true, passkeys: 0, oidc: true })).toBe(true);
    expect(hasLocalWayIn({ password: false, passkeys: 1, oidc: false })).toBe(true);
  });
});

describe('service fetch', () => {
  it('rejects a status Response cannot carry instead of throwing out of the stream', async () => {
    const server = createServer((s) => {
      s.once('data', () => s.end('HTTP/1.1 600 Odd\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}'));
      s.on('error', () => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/openid-configuration`;
      await expect(serviceFetch(url)).rejects.toThrow('unexpected status 600');
    } finally {
      await new Promise((r) => server.close(() => r(undefined)));
    }
  });

  it('keys an identity by issuer and sub without ambiguity', () => {
    expect(oidcAccountKey('https://a.example', 'x:y')).not.toBe(oidcAccountKey('https://a.example:x', 'y'));
  });
});
