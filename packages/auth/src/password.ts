import argon2 from 'argon2';
import { verifyPassword as verifyScrypt } from 'better-auth/crypto';

/**
 * Passwords stay argon2id (owner decision 2026-10-10): the hashes 0.6.x wrote
 * are copied to auth_accounts verbatim and keep working, nobody is rehashed.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/**
 * argon2 hashes are checked with argon2. Anything else is tried as Better
 * Auth's default scrypt format (`salt:key`), so a hash written by Better Auth
 * tooling cannot lock anyone out. A malformed hash is a wrong password, never
 * an exception.
 */
export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  if (!hash) return false;
  try {
    if (hash.startsWith('$argon2')) return await argon2.verify(hash, password);
    if (!/^[0-9a-f]+:[0-9a-f]+$/i.test(hash)) return false;
    return await verifyScrypt({ hash, password });
  } catch {
    return false;
  }
}
