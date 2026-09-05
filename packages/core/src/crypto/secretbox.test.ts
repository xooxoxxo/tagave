import { describe, it, expect } from 'vitest';
import { sealSecret, openSecret, isSealed, computeHint } from './secretbox.js';

describe('secretbox', () => {
  const appSecret = '0123456789abcdef0123456789abcdef'; // 32 hex chars = 16 bytes
  const appSecretWrong = 'ffffffffffffffffffffffffffffffff';

  describe('sealSecret & openSecret', () => {
    it('round trip: seal and open returns original plaintext', () => {
      const plaintext = 'my-secret-token-123456';
      const sealed = sealSecret(plaintext, appSecret);
      expect(isSealed(sealed)).toBe(true);
      expect(sealed).toMatch(/^enc:v1:.+:.+:.+$/);

      const opened = openSecret(sealed, appSecret);
      expect(opened).toBe(plaintext);
    });

    it('every seal produces different output (random IV)', () => {
      const plaintext = 'same-secret';
      const sealed1 = sealSecret(plaintext, appSecret);
      const sealed2 = sealSecret(plaintext, appSecret);
      expect(sealed1).not.toBe(sealed2);

      // But both decrypt to the same value
      expect(openSecret(sealed1, appSecret)).toBe(plaintext);
      expect(openSecret(sealed2, appSecret)).toBe(plaintext);
    });

    it('wrong key throws with clear error', () => {
      const plaintext = 'my-secret-token';
      const sealed = sealSecret(plaintext, appSecret);

      expect(() => openSecret(sealed, appSecretWrong)).toThrow(
        /wrong APP_SECRET or tampered data/
      );
    });

    it('tampered ciphertext throws with clear error', () => {
      const plaintext = 'my-secret-token';
      const sealed = sealSecret(plaintext, appSecret);

      // Tamper with the ciphertext part (last part)
      const parts = sealed.split(':');
      const tampered = [parts[0], parts[1], parts[2], parts[3], 'tampered'].join(':');

      expect(() => openSecret(tampered, appSecret)).toThrow();
    });

    it('legacy plaintext passes through unchanged', () => {
      const plaintext = 'plaintext-value';
      const opened = openSecret(plaintext, appSecret);
      expect(opened).toBe(plaintext);
    });

    it('isSealed detects sealed values', () => {
      const plaintext = 'my-secret';
      const sealed = sealSecret(plaintext, appSecret);
      expect(isSealed(sealed)).toBe(true);
      expect(isSealed(plaintext)).toBe(false);
      expect(isSealed('enc:v2:...')).toBe(true); // anything starting with enc:
    });

    it('invalid sealed format throws', () => {
      expect(() => openSecret('enc:v2:invalid', appSecret)).toThrow();
      expect(() => openSecret('enc:v1:x:y', appSecret)).toThrow(); // Missing part
    });

    it('empty plaintext throws on seal', () => {
      expect(() => sealSecret('', appSecret)).toThrow();
    });
  });

  describe('computeHint', () => {
    it('returns last 4 characters', () => {
      expect(computeHint('my-secret-token-abcd')).toBe('abcd');
      expect(computeHint('a')).toBe('a');
      expect(computeHint('abcd')).toBe('abcd');
      expect(computeHint('abcdef')).toBe('cdef');
    });

    it('returns null for empty string', () => {
      expect(computeHint('')).toBe(null);
    });
  });

  describe('APP_SECRET formats', () => {
    it('accepts hex-encoded secret', () => {
      const hexSecret = '0123456789abcdef0123456789abcdef';
      const plaintext = 'test';
      const sealed = sealSecret(plaintext, hexSecret);
      expect(openSecret(sealed, hexSecret)).toBe(plaintext);
    });

    it('accepts raw UTF-8 secret as Buffer', () => {
      const rawSecret = Buffer.from('my-app-secret-that-is-long-enough-32-chars-long');
      const plaintext = 'test';
      const sealed = sealSecret(plaintext, rawSecret);
      expect(openSecret(sealed, rawSecret)).toBe(plaintext);
    });

    it('accepts raw UTF-8 secret as string', () => {
      const rawSecret = 'my-app-secret-that-is-long-enough-32-chars-long';
      const plaintext = 'test';
      const sealed = sealSecret(plaintext, rawSecret);
      expect(openSecret(sealed, rawSecret)).toBe(plaintext);
    });
  });
});
