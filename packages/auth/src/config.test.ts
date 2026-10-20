import { describe, expect, it } from 'vitest';
import {
  AuthConfigError,
  deriveAuthSecret,
  fastifyTrustProxy,
  isPrivateAddress,
  parsePublicUrl,
  parseTrustProxy,
  passkeysCanWork,
  readAuthEnv,
  resetTrustProxyWarning,
} from './config.js';

describe('PUBLIC_URL', () => {
  it('is required, with a message that says what to set', () => {
    expect(() => parsePublicUrl(undefined)).toThrow(AuthConfigError);
    expect(() => parsePublicUrl('  ')).toThrow(/PUBLIC_URL is not set.*PUBLIC_URL=https:\/\//);
  });

  it('must be an http(s) origin with no path', () => {
    expect(() => parsePublicUrl('music.example.com')).toThrow(/not a URL/);
    expect(() => parsePublicUrl('ftp://music.example.com')).toThrow(/https:\/\/ or http:\/\//);
    expect(() => parsePublicUrl('https://example.com/tagave')).toThrow(/only scheme, host and port/);
  });

  it('gives the origin and the passkey RP ID', () => {
    expect(parsePublicUrl('https://Music.Example.com/')).toEqual({
      origin: 'https://music.example.com',
      hostname: 'music.example.com',
      secure: true,
    });
    expect(parsePublicUrl('http://localhost:3100')).toEqual({
      origin: 'http://localhost:3100',
      hostname: 'localhost',
      secure: false,
    });
  });

  it('knows where browsers allow passkeys', () => {
    expect(passkeysCanWork(parsePublicUrl('https://music.example.com'))).toBe(true);
    expect(passkeysCanWork(parsePublicUrl('http://localhost:3100'))).toBe(true);
    expect(passkeysCanWork(parsePublicUrl('http://192.168.1.5:3100'))).toBe(false);
  });
});

describe('readAuthEnv', () => {
  const base = { APP_SECRET: 'a'.repeat(64), PUBLIC_URL: 'https://music.example.com' };

  it('trusts PUBLIC_URL plus ALLOWED_ORIGINS (never "*")', () => {
    const env = readAuthEnv({ ...base, ALLOWED_ORIGINS: 'http://localhost:3001, *,https://music.example.com' });
    expect(env.trustedOrigins).toEqual(['https://music.example.com', 'http://localhost:3001']);
    expect(env.trustProxy).toBe('private');
    expect(readAuthEnv({ ...base, TRUST_PROXY: 'true' }).trustProxy).toBe(1);
  });

  it('TRUST_PROXY takes a hop count or proxy addresses, never every hop', () => {
    const warned: string[] = [];
    resetTrustProxyWarning();
    expect(parseTrustProxy(undefined)).toBe('private');
    expect(parseTrustProxy('  ')).toBe('private');
    expect(parseTrustProxy('private')).toBe('private');
    expect(parseTrustProxy('off')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('no')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.0/12,loopback')).toEqual(['10.0.0.0/8', '172.16.0.0/12', 'loopback']);
    expect(parseTrustProxy('fd00::/8')).toEqual(['fd00::/8']);
    expect(parseTrustProxy('true', (m) => warned.push(m))).toBe(1);
    expect(parseTrustProxy('yes', (m) => warned.push(m))).toBe(1);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/deprecated/);
    expect(() => parseTrustProxy('proxy.lan')).toThrow(AuthConfigError);
    expect(() => parseTrustProxy('99')).toThrow(AuthConfigError);
  });

  it('TRUST_PROXY refuses a network wider than /8: 0.0.0.0/0 or ::/0 would trust nearly every peer', () => {
    for (const v of ['0.0.0.0/0', '::/0', '10.0.0.0/7', '1.0.0.0/1', '::/7', '10.0.0.1/33', 'fd00::/129', '10.0.0.0/8,0.0.0.0/0']) {
      expect(() => parseTrustProxy(v), v).toThrow(AuthConfigError);
    }
    expect(parseTrustProxy('10.0.0.0/8')).toEqual(['10.0.0.0/8']);
    expect(parseTrustProxy('192.168.1.10/32')).toEqual(['192.168.1.10/32']);
    expect(parseTrustProxy('fd00::/128')).toEqual(['fd00::/128']);
    expect(parseTrustProxy('172.18.0.2')).toEqual(['172.18.0.2']);
  });

  it('by default, trusts private addresses as proxies (the Docker gateway too), never public ones', () => {
    const trust = fastifyTrustProxy('private') as (a: string, hop: number) => boolean;
    for (const a of ['127.0.0.1', '::1', '10.1.2.3', '172.18.0.5', '192.168.80.1', '192.168.1.20', '169.254.1.1', 'fd12::5', 'fe80::1', '::ffff:192.168.1.20']) {
      expect(trust(a, 0), a).toBe(true);
    }
    for (const a of ['203.0.113.9', '8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1', '::ffff:203.0.113.9', 'forged', '']) {
      expect(trust(a, 0), a).toBe(false);
    }
    // a proxy in another compose stack reaches the published port from tagave's network gateway
    expect(trust('::ffff:192.168.80.1', 1)).toBe(true);
    expect(isPrivateAddress('203.0.113.9')).toBe(false);
  });

  it('the other forms map to Fastify as before', () => {
    expect(fastifyTrustProxy(false)).toBe(false);
    expect(fastifyTrustProxy(0)).toBe(false);
    const hop = fastifyTrustProxy(1) as (a: string, hop: number) => boolean;
    expect([hop('203.0.113.9', 0), hop('10.0.0.1', 1)]).toEqual([true, false]);
    expect(fastifyTrustProxy(['10.0.0.0/8'])).toEqual(['10.0.0.0/8']);
  });

  it('refuses to start without PUBLIC_URL', () => {
    expect(() => readAuthEnv({ APP_SECRET: base.APP_SECRET })).toThrow(AuthConfigError);
  });
});

describe('deriveAuthSecret', () => {
  it('is stable per APP_SECRET and differs from it', () => {
    const a = deriveAuthSecret('x'.repeat(64));
    expect(a).toHaveLength(64);
    expect(a).toBe(deriveAuthSecret('x'.repeat(64)));
    expect(a).not.toBe(deriveAuthSecret('y'.repeat(64)));
    expect(a).not.toContain('xxxx');
  });
});
