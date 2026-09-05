/**
 * Credential encryption with AES-256-GCM
 *
 * Format: 'enc:v1:<base64 iv>:<base64 tag>:<base64 ciphertext>'
 * Secrets are encrypted using a key derived from APP_SECRET via HKDF-SHA256.
 * Legacy plaintext values (no 'enc:' prefix) pass through unchanged for backward compatibility.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits
const TAG_LENGTH = 16; // 128 bits
const KDF_INFO = 'liner-credentials-v1';

/**
 * Derive a key from APP_SECRET using HMAC-based KDF (compatible with older Node versions)
 * Produces a 32-byte key for AES-256
 */
function deriveKey(appSecret: string | Buffer): Buffer {
  const secretBuffer = typeof appSecret === 'string'
    ? Buffer.from(appSecret, appSecret.startsWith('0x') ? 'hex' : 'utf-8')
    : appSecret;

  // Simple KDF: HMAC-SHA256(secret, info) truncated to 32 bytes
  // This is sufficient for our use case since APP_SECRET is already random
  const hmac = createHmac('sha256', secretBuffer);
  hmac.update(KDF_INFO);
  const derived = hmac.digest();

  // If the result is exactly 32 bytes, use it; otherwise expand
  if (derived.length >= 32) {
    return derived.slice(0, 32);
  }

  // Need to expand: use iterative HMAC
  const key = Buffer.alloc(32);
  let result = derived;
  let offset = 0;

  while (offset < 32) {
    const toWrite = Math.min(result.length, 32 - offset);
    result.copy(key, offset, 0, toWrite);
    offset += toWrite;

    if (offset < 32) {
      // Expand by computing HMAC(secret, previous_result || info)
      const hmac2 = createHmac('sha256', secretBuffer);
      hmac2.update(result);
      hmac2.update(KDF_INFO);
      result = hmac2.digest();
    }
  }

  return key;
}

/**
 * Seal a plaintext value with encryption
 *
 * @param plaintext The value to encrypt
 * @param appSecret The APP_SECRET from environment (hex or raw)
 * @returns Encrypted value in format 'enc:v1:<base64 iv>:<base64 tag>:<base64 ciphertext>'
 */
export function sealSecret(plaintext: string, appSecret: string | Buffer): string {
  if (!plaintext) {
    throw new Error('Cannot seal empty plaintext');
  }

  const key = deriveKey(appSecret);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  // Format: enc:v1:<base64 iv>:<base64 tag>:<base64 ciphertext>
  const ivB64 = iv.toString('base64');
  const tagB64 = tag.toString('base64');
  const ciphertextB64 = encrypted.toString('base64');

  return `enc:v1:${ivB64}:${tagB64}:${ciphertextB64}`;
}

/**
 * Check if a value is sealed (has 'enc:' prefix)
 */
export function isSealed(value: string): boolean {
  return value.startsWith('enc:');
}

/**
 * Open (decrypt) a sealed value
 *
 * @param sealedValue The sealed value (or plaintext for legacy compatibility)
 * @param appSecret The APP_SECRET from environment
 * @returns The decrypted plaintext
 * @throws If the value is sealed but APP_SECRET is wrong or the value is tampered with
 */
export function openSecret(sealedValue: string, appSecret: string | Buffer): string {
  // Legacy passthrough: if it doesn't have the enc: prefix, return as-is
  if (!isSealed(sealedValue)) {
    return sealedValue;
  }

  const parts = sealedValue.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Invalid sealed value format');
  }

  try {
    const ivStr = parts[2];
    const tagStr = parts[3];
    const ciphertextStr = parts[4];

    if (!ivStr || !tagStr || !ciphertextStr) {
      throw new Error('Invalid sealed value format: missing parts');
    }

    const iv = Buffer.from(ivStr, 'base64');
    const tag = Buffer.from(tagStr, 'base64');
    const ciphertext = Buffer.from(ciphertextStr, 'base64');

    if (iv.length !== IV_LENGTH) {
      throw new Error(`Invalid IV length: ${iv.length} != ${IV_LENGTH}`);
    }
    if (tag.length !== TAG_LENGTH) {
      throw new Error(`Invalid tag length: ${tag.length} != ${TAG_LENGTH}`);
    }

    const key = deriveKey(appSecret);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf-8');
  } catch (err) {
    if ((err as Error).message?.includes('Unsupported state or unable to authenticate data')) {
      throw new Error('Failed to decrypt credential: wrong APP_SECRET or tampered data');
    }
    throw err;
  }
}

/**
 * Compute a hint from plaintext (last 4 characters)
 * Call before sealing to avoid having to decrypt just for the hint
 */
export function computeHint(plaintext: string): string | null {
  if (!plaintext || plaintext.length === 0) {
    return null;
  }
  return plaintext.slice(-4);
}
