/**
 * Request signatures between the app and the updater, both ways.
 *
 * Both containers get APP_SECRET from the install's .env. The signing key is
 * HMAC-SHA256(APP_SECRET, "tagave/updater/v1"), so the updater never handles
 * the secret's other uses (credential encryption, the sign-in secret) and a
 * leaked signature says nothing about APP_SECRET.
 *
 * Each request carries the time (plus a random nonce, so two requests in the
 * same millisecond differ) and an HMAC over time, method, path and a
 * SHA-256 of the body. The receiver accepts it within MAX_SKEW_MS, compares
 * in constant time, and refuses a signature it has already seen, so a
 * captured request cannot be replayed.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const KEY_LABEL = 'tagave/updater/v1';
export const TIME_HEADER = 'x-tagave-time';
export const SIGNATURE_HEADER = 'x-tagave-signature';
export const MAX_SKEW_MS = 60_000;

export function signingKey(appSecret: string): Buffer {
  if (!appSecret) throw new Error('APP_SECRET is empty');
  return createHmac('sha256', appSecret).update(KEY_LABEL).digest();
}

function payload(time: string, method: string, path: string, body: string): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return `${time}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
}

/** Headers for one request. `path` includes the query string, as sent. */
export function signRequest(
  appSecret: string,
  method: string,
  path: string,
  body = '',
  now = Date.now(),
): Record<string, string> {
  const time = `${now}.${randomBytes(8).toString('hex')}`;
  const signature = createHmac('sha256', signingKey(appSecret)).update(payload(time, method, path, body)).digest('hex');
  return { [TIME_HEADER]: time, [SIGNATURE_HEADER]: signature };
}

export interface SignedRequest {
  method: string;
  path: string;
  body: string;
  time: string | undefined;
  signature: string | undefined;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Checks signatures and remembers the ones it accepted until they could no
 * longer pass the time check anyway.
 */
export class SignatureVerifier {
  private readonly key: Buffer;
  private readonly seen = new Map<string, number>();

  constructor(appSecret: string, private readonly maxSkewMs = MAX_SKEW_MS) {
    this.key = signingKey(appSecret);
  }

  verify(req: SignedRequest, now = Date.now()): VerifyResult {
    const { time, signature } = req;
    if (!time || !signature) return { ok: false, reason: 'unsigned request' };
    const m = /^(\d{1,16})\.[0-9a-f]{16}$/.exec(time);
    if (!m || !/^[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: 'malformed signature' };
    const at = Number(m[1]);
    if (Math.abs(now - at) > this.maxSkewMs) return { ok: false, reason: 'signature expired' };
    const expected = createHmac('sha256', this.key).update(payload(time, req.method, req.path, req.body)).digest();
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad signature' };
    this.prune(now);
    if (this.seen.has(signature)) return { ok: false, reason: 'replayed signature' };
    this.seen.set(signature, at);
    return { ok: true };
  }

  private prune(now: number): void {
    for (const [sig, t] of this.seen) {
      if (Math.abs(now - t) > this.maxSkewMs) this.seen.delete(sig);
    }
  }
}
