import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CAST_TTL_S, castBase, castLink, castReach, mintCastToken, verifyCastToken } from './castTokens.js';

const appSecret = 'a'.repeat(64);
const track = randomUUID();
const user = randomUUID();

describe('cast tokens', () => {
  it('round-trips the kind, the item, the person and the expiry', () => {
    const now = Date.UTC(2026, 10, 4, 12);
    const { token, expiresAt } = mintCastToken('t', track, user, { now, appSecret });
    expect(token.length).toBeLessThanOrEqual(100);
    expect(token).not.toContain(track);
    expect(expiresAt.getTime()).toBe(now + CAST_TTL_S * 1000);
    expect(verifyCastToken(token, 't', { now, appSecret })).toEqual({ kind: 't', id: track, userId: user, expiresAt });
  });

  it('refuses another kind, another secret, an expired token and any changed part', () => {
    const now = Date.now();
    const { token } = mintCastToken('t', track, user, { now, appSecret });
    expect(verifyCastToken(token, 'c', { now, appSecret })).toBeNull();
    expect(verifyCastToken(token, 't', { now, appSecret: 'b'.repeat(64) })).toBeNull();
    expect(verifyCastToken(token, 't', { now: now + CAST_TTL_S * 1000, appSecret })).toBeNull();
    const parts = token.split('.');
    for (let i = 0; i < parts.length; i++) {
      const changed = [...parts];
      const p = changed[i]!;
      changed[i] = p.slice(0, -1) + (p.at(-1) === 'A' ? 'B' : 'A');
      expect(verifyCastToken(changed.join('.'), 't', { now, appSecret })).toBeNull();
    }
    expect(verifyCastToken(undefined, 't', { appSecret })).toBeNull();
    expect(verifyCastToken('x'.repeat(101), 't', { appSecret })).toBeNull();
    expect(verifyCastToken(`${token}.x`, 't', { now, appSecret })).toBeNull();
  });

  it('signs a uuid only', () => {
    expect(() => mintCastToken('t', 'track-1', user, { appSecret })).toThrow();
  });
});

describe('PUBLIC_URL for cast devices', () => {
  it('builds links on PUBLIC_URL, under its path, without a double slash', () => {
    expect(castLink(castBase({ PUBLIC_URL: 'https://m.example.test/' })!, '/api/v1/x')).toBe('https://m.example.test/api/v1/x');
    expect(castLink(castBase({ PUBLIC_URL: 'https://m.example.test/tagave/?q=1#h' })!, '/api/v1/x')).toBe('https://m.example.test/tagave/api/v1/x');
    expect(castBase({ PUBLIC_URL: 'not a url' })).toBeNull();
    expect(castBase({ PUBLIC_URL: 'ftp://m.example.test' })).toBeNull();
  });

  it('says how reachable it is', () => {
    expect(castReach({ PUBLIC_URL: 'https://m.example.test' })).toBe('ok');
    expect(castReach({ PUBLIC_URL: 'http://192.0.2.5:3000' })).toBe('http');
    expect(castReach({ PUBLIC_URL: 'http://localhost:3000' })).toBe('loopback');
    expect(castReach({ PUBLIC_URL: 'https://app.localhost' })).toBe('loopback');
    expect(castReach({ PUBLIC_URL: 'http://127.0.0.1:3000' })).toBe('loopback');
    expect(castReach({ PUBLIC_URL: 'http://[::1]:3000' })).toBe('loopback');
    expect(castReach({})).toBe('unset');
  });
});
