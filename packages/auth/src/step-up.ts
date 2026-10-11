/**
 * Step-up, small and self-contained: a sensitive one-time action (starting an
 * in-app update) goes through only when this session proved its owner within
 * the last STEP_UP_WINDOW_MS. A sign-in counts (auth_sessions.created_at:
 * every sign-in is a password or a passkey); so does an explicit
 * re-verification, recorded in auth_step_ups (0039).
 *
 * Re-verification methods, strongest first: a passkey or security key (with
 * its PIN or fingerprint), the authenticator app, and the password only for
 * an account with neither (owner decision 2026-10-10, item 3).
 *
 * Keyward will generalise this; until then it stays this one file.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { symmetricDecrypt } from 'better-auth/crypto';
import type postgres from 'postgres';
import { deriveAuthSecret } from './config.js';
import { verifyPassword } from './password.js';

/** Owner decision 2026-10-10, item 7: 5 minutes for one-time actions. */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type StepUpMethod = 'passkey' | 'totp' | 'password';

/** The methods this account may re-verify with, strongest first. */
export async function stepUpMethods(sql: postgres.Sql, userId: string, passkeysUsable = true): Promise<StepUpMethod[]> {
  const [row] = await sql<Array<{ passkeys: number; totp: boolean; password: boolean }>>`
    select
      (select count(*)::int from auth_passkeys where user_id = ${userId}) as passkeys,
      exists (select 1 from users u join auth_two_factors t on t.user_id = u.id
               where u.id = ${userId} and u.two_factor_enabled and t.verified is not false) as totp,
      exists (select 1 from auth_accounts where user_id = ${userId} and provider_id = 'credential' and password is not null) as password`;
  const methods: StepUpMethod[] = [];
  if (row && row.passkeys > 0 && passkeysUsable) methods.push('passkey');
  if (row?.totp) methods.push('totp');
  // The password alone is a fallback only for an account with no second factor.
  if (row?.password && row.passkeys === 0 && !row.totp) methods.push('password');
  return methods;
}

/** When this session last proved its owner: the later of its sign-in and its last re-verification. */
export async function lastVerifiedAt(sql: postgres.Sql, sessionId: string): Promise<Date | null> {
  const [row] = await sql<Array<{ at: Date | null }>>`
    select greatest(s.created_at, su.verified_at) as at
      from auth_sessions s left join auth_step_ups su on su.session_id = s.id
     where s.id = ${sessionId}`;
  return row?.at ? new Date(row.at) : null;
}

export function isFresh(verifiedAt: Date | null, now = Date.now(), windowMs = STEP_UP_WINDOW_MS): boolean {
  return verifiedAt !== null && now - verifiedAt.getTime() <= windowMs && verifiedAt.getTime() <= now + 60_000;
}

export async function recordStepUp(sql: postgres.Sql, sessionId: string, userId: string, method: StepUpMethod): Promise<Date> {
  const [row] = await sql<Array<{ verified_at: Date }>>`
    insert into auth_step_ups (session_id, user_id, method, verified_at)
    values (${sessionId}, ${userId}, ${method}, now())
    on conflict (session_id) do update set method = excluded.method, verified_at = excluded.verified_at
    returning verified_at`;
  return new Date(row!.verified_at);
}

export async function verifyPasswordStepUp(sql: postgres.Sql, userId: string, password: string): Promise<boolean> {
  const [row] = await sql<Array<{ password: string }>>`
    select password from auth_accounts where user_id = ${userId} and provider_id = 'credential' and password is not null`;
  return row ? verifyPassword({ hash: row.password, password }) : false;
}

/** RFC 6238 (SHA-1, 6 digits, 30 s, one step either side), as Better Auth's two-factor plugin checks it. */
export function totpMatches(secret: string, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const key = Buffer.from(secret, 'utf8');
  const step = Math.floor(now / 30_000);
  let matched = false;
  for (let i = -1; i <= 1; i++) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step + i));
    const mac = createHmac('sha1', key).update(counter).digest();
    const offset = mac[mac.length - 1]! & 0x0f;
    const value = String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
    matched = timingSafeEqual(Buffer.from(value), Buffer.from(code)) || matched;
  }
  return matched;
}

export async function verifyTotpStepUp(sql: postgres.Sql, appSecret: string, userId: string, code: string): Promise<boolean> {
  const [row] = await sql<Array<{ secret: string }>>`
    select t.secret from auth_two_factors t join users u on u.id = t.user_id
     where t.user_id = ${userId} and u.two_factor_enabled and t.verified is not false`;
  if (!row) return false;
  let secret: string;
  try {
    secret = await symmetricDecrypt({ key: deriveAuthSecret(appSecret), data: row.secret });
  } catch {
    return false;
  }
  return totpMatches(secret, code.trim());
}

const challengeId = (sessionId: string) => `tagave-step-up:${sessionId}`;

/** WebAuthn options for a re-verification with one of this user's passkeys. The challenge is kept server-side, per session. */
export async function passkeyStepUpOptions(sql: postgres.Sql, opts: { rpID: string; userId: string; sessionId: string }) {
  const keys = await sql<Array<{ credential_id: string; transports: string | null }>>`
    select credential_id, transports from auth_passkeys where user_id = ${opts.userId}`;
  const options = await generateAuthenticationOptions({
    rpID: opts.rpID,
    userVerification: 'required',
    allowCredentials: keys.map((k) => ({
      id: k.credential_id,
      ...(k.transports ? { transports: k.transports.split(',') as never } : {}),
    })),
  });
  const id = challengeId(opts.sessionId);
  await sql.begin(async (tx) => {
    await tx`delete from auth_verifications where identifier = ${id}`;
    await tx`insert into auth_verifications (identifier, value, expires_at)
             values (${id}, ${JSON.stringify({ challenge: options.challenge, nonce: randomBytes(4).toString('hex') })}, ${new Date(Date.now() + CHALLENGE_TTL_MS)})`;
  });
  return options;
}

export async function verifyPasskeyStepUp(
  sql: postgres.Sql,
  opts: { rpID: string; origin: string; userId: string; sessionId: string; response: AuthenticationResponseJSON },
): Promise<boolean> {
  const id = challengeId(opts.sessionId);
  // One use per challenge: taken out of the table before it is checked.
  const [stored] = await sql<Array<{ value: string; expires_at: Date }>>`
    delete from auth_verifications where identifier = ${id} returning value, expires_at`;
  if (!stored || new Date(stored.expires_at).getTime() < Date.now()) return false;
  const { challenge } = JSON.parse(stored.value) as { challenge: string };
  const [key] = await sql<Array<{ id: string; credential_id: string; public_key: string; counter: number; transports: string | null }>>`
    select id, credential_id, public_key, counter, transports from auth_passkeys
     where credential_id = ${opts.response.id} and user_id = ${opts.userId}`;
  if (!key) return false;
  try {
    const result = await verifyAuthenticationResponse({
      response: opts.response,
      expectedChallenge: challenge,
      expectedOrigin: opts.origin,
      expectedRPID: opts.rpID,
      credential: {
        id: key.credential_id,
        publicKey: new Uint8Array(Buffer.from(key.public_key, 'base64')),
        counter: Number(key.counter),
        ...(key.transports ? { transports: key.transports.split(',') as never } : {}),
      },
      requireUserVerification: true,
    });
    if (!result.verified || !result.authenticationInfo.userVerified) return false;
    await sql`update auth_passkeys set counter = ${result.authenticationInfo.newCounter} where id = ${key.id}`;
    return true;
  } catch {
    return false;
  }
}
