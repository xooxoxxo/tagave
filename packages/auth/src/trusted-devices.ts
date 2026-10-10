import type postgres from 'postgres';

/**
 * Trusted devices ("don't ask for a code on this device for 30 days").
 * Better Auth keeps one opaque verification row per trusted browser
 * (identifier `trust-device-…`, value = user id) and rotates it on every
 * trusted sign-in. auth_trusted_devices names those rows (browser, first and
 * last use) so Settings › Security can list them and revoke any one of them
 * (owner decision 2026-10-10: a revocable list).
 */

export const TRUST_DEVICE_PREFIX = 'trust-device-';

/** The part of Better Auth's endpoint context the hook reads. */
interface HookContext {
  headers?: Headers | undefined;
}

const TRUST_COOKIE_RE = /(?:^|;\s*)(?:__Secure-)?tagave\.trust_device=([^;]*)/;

function clientIp(headers: Headers | undefined, trustProxy: boolean): string | null {
  if (!headers || !trustProxy) return null;
  const forwarded = headers.get('x-forwarded-for');
  return forwarded ? forwarded.split(',')[0]!.trim() : null;
}

/** databaseHooks.verification.create.after: name a new or rotated trust row. */
export async function recordTrustedDevice(
  sql: postgres.Sql,
  verification: { identifier?: string; value?: string },
  ctx: HookContext | null | undefined,
  trustProxy: boolean,
): Promise<void> {
  const identifier = verification.identifier;
  const userId = verification.value;
  if (!identifier?.startsWith(TRUST_DEVICE_PREFIX) || !userId) return;

  // A rotation (trusted sign-in) carries the previous trust cookie, which
  // Better Auth has just verified (HMAC) before replacing its row.
  const raw = TRUST_COOKIE_RE.exec(ctx?.headers?.get('cookie') ?? '')?.[1];
  const previous = trustIdentifierFromCookie(raw);
  const userAgent = ctx?.headers?.get('user-agent') ?? null;
  const ip = clientIp(ctx?.headers, trustProxy);

  if (previous && previous !== identifier) {
    const moved = await sql`
      update auth_trusted_devices
         set identifier = ${identifier}, last_used_at = now(),
             user_agent = coalesce(${userAgent}, user_agent), ip_address = coalesce(${ip}, ip_address)
       where identifier = ${previous} and user_id = ${userId}
      returning id`;
    if (moved.length > 0) return;
  }
  await sql`
    insert into auth_trusted_devices (user_id, identifier, user_agent, ip_address)
    values (${userId}, ${identifier}, ${userAgent}, ${ip})
    on conflict (identifier) do nothing`;
}

export interface TrustedDevice {
  id: string;
  identifier: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

/** The user's live trusted devices, newest use first (forgets expired ones). */
export async function listTrustedDevices(sql: postgres.Sql, userId: string): Promise<TrustedDevice[]> {
  await sql`
    delete from auth_trusted_devices t
     where t.user_id = ${userId}
       and not exists (select 1 from auth_verifications v
                        where v.identifier = t.identifier and v.value = ${userId} and v.expires_at > now())`;
  const rows = await sql<Array<{
    id: string; identifier: string; user_agent: string | null; ip_address: string | null;
    created_at: Date; last_used_at: Date; expires_at: Date;
  }>>`
    select t.id, t.identifier, t.user_agent, t.ip_address, t.created_at, t.last_used_at, v.expires_at
      from auth_trusted_devices t
      join auth_verifications v on v.identifier = t.identifier and v.value = ${userId}
     where t.user_id = ${userId}
     order by t.last_used_at desc`;
  return rows.map((r) => ({
    id: r.id,
    identifier: r.identifier,
    userAgent: r.user_agent,
    ipAddress: r.ip_address,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  }));
}

/** Forget one trusted device: its next sign-in asks for a code again. */
export async function revokeTrustedDevice(sql: postgres.Sql, userId: string, id: string): Promise<boolean> {
  const rows = await sql<Array<{ identifier: string }>>`
    delete from auth_trusted_devices where id = ${id} and user_id = ${userId} returning identifier`;
  const row = rows[0];
  if (!row) return false;
  await sql`delete from auth_verifications where identifier = ${row.identifier} and value = ${userId}`;
  return true;
}

/** Forget every trusted device of a user (2FA turned off, password changed). */
export async function revokeAllTrustedDevices(sql: postgres.Sql, userId: string): Promise<number> {
  const rows = await sql`
    delete from auth_verifications
     where identifier like ${TRUST_DEVICE_PREFIX + '%'} and value = ${userId}
    returning id`;
  await sql`delete from auth_trusted_devices where user_id = ${userId}`;
  return rows.length;
}

/** The trust-device identifier inside a raw `tagave.trust_device` cookie value (signature not checked). */
export function trustIdentifierFromCookie(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  const dot = value.lastIndexOf('.');
  const payload = dot > 0 ? value.slice(0, dot) : value;
  const id = payload.split('!')[1];
  return id?.startsWith(TRUST_DEVICE_PREFIX) ? id : undefined;
}
