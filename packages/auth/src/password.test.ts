import { describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { hashPassword as scryptHash } from 'better-auth/crypto';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing (argon2id kept, scrypt accepted)', () => {
  it('hashes new passwords as argon2id', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword({ hash, password: 'correct horse battery' })).toBe(true);
  });

  it('accepts a hash written by tagave 0.6.x (argon2 defaults)', async () => {
    const legacy = await argon2.hash('the owner password');
    expect(await verifyPassword({ hash: legacy, password: 'the owner password' })).toBe(true);
    expect(await verifyPassword({ hash: legacy, password: 'not it' })).toBe(false);
  });

  it("accepts Better Auth's scrypt format so its tooling cannot lock anyone out", async () => {
    const hash = await scryptHash('scrypt password!');
    expect(hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(await verifyPassword({ hash, password: 'scrypt password!' })).toBe(true);
    expect(await verifyPassword({ hash, password: 'wrong' })).toBe(false);
  });

  it('treats malformed hashes as a wrong password, never an exception', async () => {
    for (const hash of ['', 'test-hash', 'x', '$argon2id$garbage', 'zz:yy', 'abc:']) {
      expect(await verifyPassword({ hash, password: 'anything' })).toBe(false);
    }
  });
});
