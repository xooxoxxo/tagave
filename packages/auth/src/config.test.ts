import { describe, expect, it } from 'vitest';
import { AuthConfigError, deriveAuthSecret, parsePublicUrl, passkeysCanWork, readAuthEnv } from './config.js';

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
    expect(env.trustProxy).toBe(false);
    expect(readAuthEnv({ ...base, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
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
