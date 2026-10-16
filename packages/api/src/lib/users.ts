/**
 * People on this install (Settings › Users): the list, invite and
 * set-password links, role changes, turning an account off, removing it.
 * All SQL runs on the auth layer's pool; every change that could leave the
 * install without an owner holds USERS_LOCK_KEY for its transaction.
 */
import { createHash, randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import { INVITE_TTL_DAYS, type InvitePurpose, type InviteView, type Role, type UserView } from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { toRole } from '../middleware/auth.js';

/** Held (transaction-scoped) while a change checks "at least one owner". */
export const USERS_LOCK_KEY = 7_302_026_116;

const DAY_MS = 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 32 random bytes, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function inviteLink(publicOrigin: string, token: string): string {
  return `${publicOrigin}/invite/${token}`;
}

interface UserRow {
  id: string;
  display_name: string | null;
  email: string;
  role: string;
  created_at: Date;
  disabled_at: Date | null;
  removed_at: Date | null;
  last_seen_at: Date | null;
  two_factor: boolean;
  passkeys: number;
}

function toUserView(row: UserRow, selfId: string): UserView {
  return {
    id: row.id,
    name: row.display_name || row.email,
    email: row.removed_at ? '' : row.email,
    role: toRole(row.role),
    status: row.removed_at ? 'removed' : row.disabled_at ? 'disabled' : 'active',
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    twoFactor: row.two_factor,
    passkeys: row.passkeys,
    isSelf: row.id === selfId,
  };
}

interface InviteRow {
  id: string;
  purpose: string;
  email: string;
  role: string;
  user_id: string | null;
  created_at: Date;
  expires_at: Date;
  created_by_name: string | null;
}

function toInviteView(row: InviteRow, now = Date.now()): InviteView {
  return {
    id: row.id,
    purpose: row.purpose === 'reset' ? 'reset' : 'invite',
    email: row.email,
    role: toRole(row.role),
    userId: row.user_id,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    expired: row.expires_at.getTime() <= now,
    createdBy: row.created_by_name,
  };
}

export async function listUsers(sql: postgres.Sql, selfId: string): Promise<{ users: UserView[]; invites: InviteView[] }> {
  const users = await sql<UserRow[]>`
    select u.id, u.display_name, u.email, u.role, u.created_at, u.disabled_at, u.removed_at,
           (select greatest(max(s.updated_at), max(s.created_at)) from auth_sessions s where s.user_id = u.id) as last_seen_at,
           (u.two_factor_enabled and exists (select 1 from auth_two_factors t where t.user_id = u.id and t.verified is not false)) as two_factor,
           (select count(*)::int from auth_passkeys p where p.user_id = u.id) as passkeys
      from users u
     order by (u.removed_at is not null), (u.role = 'owner') desc, lower(coalesce(u.display_name, u.email))`;
  const invites = await sql<InviteRow[]>`
    select i.id, i.purpose, i.email, i.role, i.user_id, i.created_at, i.expires_at,
           coalesce(c.display_name, c.email) as created_by_name
      from user_invites i left join users c on c.id = i.created_by
     where i.used_at is null and i.revoked_at is null and i.expires_at > now() - interval '1 day'
     order by i.created_at desc`;
  return { users: users.map((u) => toUserView(u, selfId)), invites: invites.map((i) => toInviteView(i)) };
}

async function lockUsers(tx: postgres.TransactionSql): Promise<void> {
  await tx`select pg_advisory_xact_lock(${USERS_LOCK_KEY}::bigint)`;
}

async function activeOwnerCount(tx: postgres.TransactionSql, exceptId?: string): Promise<number> {
  const [row] = await tx<Array<{ n: number }>>`
    select count(*)::int as n from users
     where role = 'owner' and disabled_at is null and removed_at is null
       and (${exceptId ?? null}::uuid is null or id <> ${exceptId ?? null}::uuid)`;
  return row?.n ?? 0;
}

async function loadUser(tx: postgres.TransactionSql | postgres.Sql, userId: string) {
  const [row] = await tx<Array<{ id: string; email: string; role: string; display_name: string | null; disabled_at: Date | null; removed_at: Date | null }>>`
    select id, email, role, display_name, disabled_at, removed_at from users where id = ${userId}`;
  if (!row) throw new ApiError(404, 'Not Found', 'No such person on this tagave');
  return row;
}

const LAST_OWNER = 'tagave needs at least one owner who can sign in. Make someone else an owner first.';

/** End every way in: sessions (new and legacy), trusted devices, step-ups. */
async function signOutEverywhere(tx: postgres.TransactionSql, userId: string): Promise<void> {
  await tx`delete from auth_sessions where user_id = ${userId}`;
  await tx`delete from sessions where user_id = ${userId}`;
  await tx`delete from auth_trusted_devices where user_id = ${userId}`;
  await tx`delete from auth_verifications where identifier like 'trust-device-%' and value = ${userId}`;
}

export async function createLink(
  sql: postgres.Sql,
  opts: { purpose: InvitePurpose; email: string; role: Role; userId?: string; clearSecondFactors?: boolean; createdBy: string },
): Promise<{ invite: InviteView; token: string }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * DAY_MS);
  const row = await sql.begin(async (tx) => {
    await lockUsers(tx);
    if (opts.purpose === 'invite') {
      const [taken] = await tx`select 1 from users where lower(email) = ${opts.email.toLowerCase()} and removed_at is null`;
      if (taken) throw new ApiError(409, 'Conflict', 'Someone on this tagave already uses that email address.');
      // A new invite to the same address replaces the open one.
      await tx`update user_invites set revoked_at = now()
                where purpose = 'invite' and lower(email) = ${opts.email.toLowerCase()} and used_at is null and revoked_at is null`;
    } else {
      await tx`update user_invites set revoked_at = now()
                where purpose = 'reset' and user_id = ${opts.userId!} and used_at is null and revoked_at is null`;
    }
    const [inserted] = await tx<InviteRow[]>`
      insert into user_invites (token_hash, purpose, email, role, user_id, clear_second_factors, created_by, expires_at)
      values (${hashToken(token)}, ${opts.purpose}, ${opts.email}, ${opts.role}, ${opts.userId ?? null},
              ${opts.clearSecondFactors ?? false}, ${opts.createdBy}, ${expiresAt})
      returning id, purpose, email, role, user_id, created_at, expires_at,
                (select coalesce(display_name, email) from users where id = ${opts.createdBy}) as created_by_name`;
    return inserted!;
  });
  return { invite: toInviteView(row), token };
}

export async function revokeInvite(sql: postgres.Sql, inviteId: string): Promise<void> {
  const rows = await sql`update user_invites set revoked_at = now() where id = ${inviteId} and used_at is null and revoked_at is null returning id`;
  if (rows.length === 0) throw new ApiError(404, 'Not Found', 'That link was already used or revoked');
}

/** A set-password link for someone already on the install. */
export async function resetLinkFor(sql: postgres.Sql, userId: string, clearSecondFactors: boolean, createdBy: string) {
  const user = await loadUser(sql, userId);
  if (user.removed_at) throw new ApiError(409, 'Conflict', 'This account was removed.');
  if (user.disabled_at) throw new ApiError(409, 'Conflict', 'This account is turned off. Turn it back on first.');
  return createLink(sql, { purpose: 'reset', email: user.email, role: toRole(user.role), userId, clearSecondFactors, createdBy });
}

export async function changeUser(
  sql: postgres.Sql,
  actorId: string,
  userId: string,
  change: { role?: Role | undefined; disabled?: boolean | undefined },
): Promise<void> {
  await sql.begin(async (tx) => {
    await lockUsers(tx);
    const user = await loadUser(tx, userId);
    if (user.removed_at) throw new ApiError(409, 'Conflict', 'This account was removed.');
    if (change.disabled === true && userId === actorId) {
      throw new ApiError(409, 'Conflict', 'You cannot turn off your own account here.');
    }
    const losesOwner = user.role === 'owner' && !user.disabled_at
      && ((change.role !== undefined && change.role !== 'owner') || change.disabled === true);
    if (losesOwner && (await activeOwnerCount(tx, userId)) === 0) {
      throw new ApiError(409, 'Conflict', LAST_OWNER);
    }
    if (change.role !== undefined) {
      await tx`update users set role = ${change.role}, updated_at = now() where id = ${userId}`;
    }
    if (change.disabled === true && !user.disabled_at) {
      await tx`update users set disabled_at = now(), updated_at = now() where id = ${userId}`;
      await signOutEverywhere(tx, userId);
      await tx`update user_invites set revoked_at = now() where user_id = ${userId} and used_at is null and revoked_at is null`;
    } else if (change.disabled === false && user.disabled_at) {
      await tx`update users set disabled_at = null, updated_at = now() where id = ${userId}`;
    }
  });
}

/**
 * Remove someone. keep: the account is closed for good (sign-in rows and
 * email gone, name kept) and their ratings, reviews and listens stay.
 * delete: the account row goes, and with it everything keyed to them.
 * Either way, what they made for the whole library (libraries, tag changes,
 * field locks) is handed to the owner removing them.
 */
export async function removeUser(sql: postgres.Sql, actorId: string, userId: string, data: 'keep' | 'delete'): Promise<void> {
  if (userId === actorId) throw new ApiError(409, 'Conflict', 'You cannot remove your own account here.');
  await sql.begin(async (tx) => {
    await lockUsers(tx);
    const user = await loadUser(tx, userId);
    if (user.role === 'owner' && !user.disabled_at && !user.removed_at && (await activeOwnerCount(tx, userId)) === 0) {
      throw new ApiError(409, 'Conflict', LAST_OWNER);
    }
    await tx`update libraries set owner_user_id = ${actorId} where owner_user_id = ${userId}`;
    await tx`update tag_plans set created_by = ${actorId} where created_by = ${userId}`;
    await tx`update field_locks set created_by = ${actorId} where created_by = ${userId}`;
    await tx`update cluster_overrides set created_by = ${actorId} where created_by = ${userId}`;
    if (data === 'delete') {
      await tx`delete from users where id = ${userId}`;
      return;
    }
    await signOutEverywhere(tx, userId);
    await tx`delete from auth_accounts where user_id = ${userId}`;
    await tx`delete from auth_passkeys where user_id = ${userId}`;
    await tx`delete from auth_two_factors where user_id = ${userId}`;
    await tx`delete from user_invites where user_id = ${userId}`;
    await tx`
      update users
         set removed_at = coalesce(removed_at, now()), disabled_at = coalesce(disabled_at, now()),
             email = ${`removed-${userId}@removed.invalid`}, password_hash = null,
             two_factor_enabled = false, updated_at = now()
       where id = ${userId}`;
  });
}

export interface ClaimedLink {
  id: string;
  purpose: InvitePurpose;
  email: string;
  role: Role;
  userId: string | null;
  clearSecondFactors: boolean;
  expiresAt: Date;
}

interface LinkRow {
  id: string;
  purpose: string;
  email: string;
  role: string;
  user_id: string | null;
  clear_second_factors: boolean;
  expires_at: Date;
}

const toClaimed = (r: LinkRow): ClaimedLink => ({
  id: r.id,
  purpose: r.purpose === 'reset' ? 'reset' : 'invite',
  email: r.email,
  role: toRole(r.role),
  userId: r.user_id,
  clearSecondFactors: r.clear_second_factors,
  expiresAt: r.expires_at,
});

/** An open link (not used, revoked or expired), without using it. */
export async function findOpenLink(sql: postgres.Sql, token: string): Promise<(ClaimedLink & { name: string | null }) | null> {
  const [row] = await sql<Array<LinkRow & { name: string | null }>>`
    select i.id, i.purpose, i.email, i.role, i.user_id, i.clear_second_factors, i.expires_at, u.display_name as name
      from user_invites i left join users u on u.id = i.user_id
     where i.token_hash = ${hashToken(token)} and i.used_at is null and i.revoked_at is null and i.expires_at > now()`;
  return row ? { ...toClaimed(row), name: row.name } : null;
}

/** Take the link (one use): later calls with the same token find nothing. */
export async function claimLink(sql: postgres.Sql, token: string): Promise<ClaimedLink | null> {
  const [row] = await sql<LinkRow[]>`
    update user_invites set used_at = now()
     where token_hash = ${hashToken(token)} and used_at is null and revoked_at is null and expires_at > now()
     returning id, purpose, email, role, user_id, clear_second_factors, expires_at`;
  return row ? toClaimed(row) : null;
}

/** The account could not be made after all: the link works again. */
export async function releaseLink(sql: postgres.Sql, id: string): Promise<void> {
  await sql`update user_invites set used_at = null where id = ${id}`;
}
