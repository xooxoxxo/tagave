/**
 * Token-shaped input rules for a provider: PKCE S256 only (RFC 7636 shapes),
 * a bearer header with exactly one token, and length caps checked before any
 * lookup.
 */
import { MAX_TOKEN_LENGTH } from "./limits.js";

/** A PKCE S256 code challenge: base64url of a SHA-256, 43 characters, no padding. */
export const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
/** A PKCE code verifier (RFC 7636 §4.1): 43 to 128 unreserved characters. */
export const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export const isPkceChallenge = (s: unknown): s is string => typeof s === "string" && PKCE_CHALLENGE_RE.test(s);
export const isPkceVerifier = (s: unknown): s is string => typeof s === "string" && PKCE_VERIFIER_RE.test(s);

/** The one token of an `Authorization: Bearer <token>` header, or ''. Never log what this returns. */
export function bearerToken(header: string | undefined | null): string {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m ? m[1]! : "";
}

/** A token, code or secret short enough to look up (non-empty, at most MAX_TOKEN_LENGTH). */
export const isLookupLength = (s: unknown, max: number = MAX_TOKEN_LENGTH): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= max;
