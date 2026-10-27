/**
 * One player-server account per tagave person, so their plays, play counts,
 * ratings and stars are theirs and never the admin's.
 *
 * Bundled Navidrome: tagave creates the account (on the person's first play,
 * or within a minute of the person being added) through Navidrome's user
 * API as its admin, with a random password sealed with APP_SECRET that is
 * never shown. A person may set their own password for phone apps; it is
 * stored the same way. A disabled or closed tagave account locks its
 * Navidrome account (a new random password); enabling it again unlocks it
 * with another random password (phone apps then need the person's new one).
 *
 * A server the owner runs: each person may enter their own login there.
 * Without one they play through the shared account the owner saved; then
 * the server cannot tell people apart, so tagave neither reports their web
 * plays to it nor reads plays from other apps for them.
 */
import type postgres from 'postgres';
import { openSecret, sealSecret } from '@tagave/core';
import {
  NavidromeError,
  createNavidromeUser,
  freePlayerUserName,
  listNavidromeUsers,
  ping,
  playerUserName,
  randomPlayerPassword,
  updateNavidromeUser,
  type PlayerBackend,
  type SubsonicServer,
} from '@tagave/core/player';
import type { PlayerAccountView } from '@tagave/shared';

type Sql = postgres.Sql;

export function appSecret(): string {
  const s = process.env['APP_SECRET'];
  if (!s) throw new Error('APP_SECRET is not set');
  return s;
}

export interface PlayerUserRow {
  user_id: string;
  server_key: string;
  username: string;
  server_user_id: string | null;
  password_sealed: string;
  source: 'managed' | 'person';
  phone_password: boolean;
  state: 'active' | 'disabled';
  server_scrobbles: boolean;
  last_error: string | null;
}

export type PersonKind = 'bundled' | 'own' | 'shared';

/** The server as this person: their own credentials, or (shared) the owner's account. */
export interface PersonServer {
  server: SubsonicServer;
  serverKey: string;
  kind: PersonKind;
  /** the server knows this person apart from everyone else (their plays, counts and ratings are theirs) */
  personal: boolean;
  /** the owner's server scrobbles for this person already: tagave sends no scrobbles of its own */
  serverScrobbles: boolean;
}

export class PlayerAccountError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = 'PlayerAccountError';
  }
}

interface Person { id: string; email: string; display_name: string | null; disabled: boolean }

async function person(sql: Sql, userId: string): Promise<Person | null> {
  const rows = await sql<Person[]>`
    select id, email, display_name, (disabled_at is not null or removed_at is not null) as disabled
    from users where id = ${userId}`;
  return rows[0] ?? null;
}

export async function playerUserRow(sql: Sql, userId: string, serverKey: string): Promise<PlayerUserRow | null> {
  const rows = await sql<PlayerUserRow[]>`
    select user_id, server_key, username, server_user_id, password_sealed, source, phone_password, state, server_scrobbles, last_error
    from player_users where user_id = ${userId} and server_key = ${serverKey}`;
  return rows[0] ?? null;
}

const lockKey = (userId: string) => `tagave:player-user:${userId}`;

/**
 * The person's Navidrome account on the bundled server, made when missing.
 * Serialised per person (two streams starting at once make one account).
 */
export async function ensureBundledUser(sql: Sql, backend: PlayerBackend, userId: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<PlayerUserRow> {
  if (backend.managed !== 'bundled') throw new Error('ensureBundledUser needs the bundled player');
  const existing = await playerUserRow(sql, userId, backend.key);
  if (existing) return existing;
  const f = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {};
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${lockKey(userId)}))`;
    const again = await playerUserRow(tx as unknown as Sql, userId, backend.key);
    if (again) return again;
    const who = await person(tx as unknown as Sql, userId);
    if (!who) throw new PlayerAccountError('This account does not exist', 404);
    if (who.disabled) throw new PlayerAccountError('This account is disabled', 403);
    const onServer = await listNavidromeUsers(backend.server, f);
    const ours = await tx<{ username: string }[]>`select username from player_users where server_key = ${backend.key}`;
    const name = freePlayerUserName(playerUserName({ displayName: who.display_name, email: who.email }), [...onServer.map((u) => u.userName), ...ours.map((r) => r.username), backend.server.username]);
    const password = randomPlayerPassword();
    const id = await createNavidromeUser(backend.server, { userName: name, name: who.display_name?.trim() || name, password }, f);
    const rows = await tx<PlayerUserRow[]>`
      insert into player_users (user_id, server_key, username, server_user_id, password_sealed, source)
      values (${userId}, ${backend.key}, ${name}, ${id}, ${sealSecret(password, appSecret())}, 'managed')
      returning user_id, server_key, username, server_user_id, password_sealed, source, phone_password, state, server_scrobbles, last_error`;
    return rows[0]!;
  });
}

function credentials(backend: PlayerBackend, row: PlayerUserRow): SubsonicServer {
  return { url: backend.server.url, username: row.username, password: openSecret(row.password_sealed, appSecret()) };
}

/**
 * How tagave talks to the server for this person. `create` makes their
 * bundled account when it is missing (a play); without it a missing account
 * gives null (background work for someone who never played).
 */
export async function personServer(sql: Sql, backend: PlayerBackend, userId: string, opts: { create?: boolean; fetchImpl?: typeof fetch } = {}): Promise<PersonServer | null> {
  if (backend.managed === 'bundled') {
    let row = await playerUserRow(sql, userId, backend.key);
    if (!row && opts.create) row = await ensureBundledUser(sql, backend, userId, opts);
    if (!row) return null;
    if (row.state !== 'active') throw new PlayerAccountError('This account is disabled', 403);
    return { server: credentials(backend, row), serverKey: backend.key, kind: 'bundled', personal: true, serverScrobbles: false };
  }
  const row = await playerUserRow(sql, userId, backend.key);
  if (row && row.state === 'active') {
    return { server: credentials(backend, row), serverKey: backend.key, kind: 'own', personal: true, serverScrobbles: row.server_scrobbles };
  }
  return { server: backend.server, serverKey: backend.key, kind: 'shared', personal: false, serverScrobbles: false };
}

/** Settings › Listening: the person's account, never its password. */
export async function accountView(sql: Sql, backend: PlayerBackend | null, userId: string): Promise<PlayerAccountView> {
  if (!backend) return { kind: 'none', username: null, phonePassword: false, serverScrobbles: false, state: null, lastError: null };
  const row = await playerUserRow(sql, userId, backend.key);
  if (backend.managed === 'bundled') {
    return { kind: 'bundled', username: row?.username ?? null, phonePassword: row?.phone_password ?? false, serverScrobbles: false, state: row?.state ?? null, lastError: row?.last_error ?? null };
  }
  if (row) return { kind: 'own', username: row.username, phonePassword: false, serverScrobbles: row.server_scrobbles, state: row.state, lastError: row.last_error };
  return { kind: 'shared', username: null, phonePassword: false, serverScrobbles: false, state: null, lastError: null };
}

/** The Navidrome id of the person's account (looked up by name when tagave lost it). */
async function navidromeId(backend: PlayerBackend, row: PlayerUserRow, f: { fetchImpl?: typeof fetch }): Promise<string> {
  if (row.server_user_id) return row.server_user_id;
  const found = (await listNavidromeUsers(backend.server, f)).find((u) => u.userName.toLowerCase() === row.username.toLowerCase());
  if (!found) throw new PlayerAccountError('The player server no longer has this account');
  return found.id;
}

/** The person's own password for phone apps (bundled player). Stored sealed; tagave keeps using it. */
export async function setPhonePassword(sql: Sql, backend: PlayerBackend, userId: string, password: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<PlayerUserRow> {
  if (backend.managed !== 'bundled') throw new PlayerAccountError('Phone passwords are set on the bundled player only; on your own server, change it there');
  const f = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {};
  const row = await ensureBundledUser(sql, backend, userId, opts);
  if (row.state !== 'active') throw new PlayerAccountError('This account is disabled', 403);
  const id = await navidromeId(backend, row, f);
  await updateNavidromeUser(backend.server, id, { password }, f);
  const rows = await sql<PlayerUserRow[]>`
    update player_users set password_sealed = ${sealSecret(password, appSecret())}, phone_password = true, server_user_id = ${id},
      last_error = null, last_error_at = null, updated_at = now()
    where user_id = ${userId} and server_key = ${backend.key}
    returning user_id, server_key, username, server_user_id, password_sealed, source, phone_password, state, server_scrobbles, last_error`;
  return rows[0]!;
}

/** Back to a random password nobody knows (phone apps signed in with the old one stop working). */
export async function clearPhonePassword(sql: Sql, backend: PlayerBackend, userId: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<void> {
  if (backend.managed !== 'bundled') return;
  const row = await playerUserRow(sql, userId, backend.key);
  if (!row) return;
  const f = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {};
  const password = randomPlayerPassword();
  const id = await navidromeId(backend, row, f);
  await updateNavidromeUser(backend.server, id, { password }, f);
  await sql`
    update player_users set password_sealed = ${sealSecret(password, appSecret())}, phone_password = false, server_user_id = ${id}, updated_at = now()
    where user_id = ${userId} and server_key = ${backend.key}`;
}

/** The person's login on the owner's own server; tested before it is saved. */
export async function saveOwnAccount(sql: Sql, backend: PlayerBackend, userId: string, body: { username: string; password?: string | undefined; serverScrobbles: boolean }, opts: { fetchImpl?: typeof fetch } = {}): Promise<void> {
  if (backend.managed !== 'external') throw new PlayerAccountError('The bundled player makes your account itself');
  const saved = await playerUserRow(sql, userId, backend.key);
  const password = body.password ?? (saved && saved.username === body.username ? openSecret(saved.password_sealed, appSecret()) : undefined);
  if (!password) throw new PlayerAccountError('Enter your password on that server', 400);
  try {
    await ping({ url: backend.server.url, username: body.username, password }, { timeoutMs: 8000, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  } catch (err) {
    throw new PlayerAccountError(`Could not sign in: ${(err as Error).message}`, 400);
  }
  const taken = await sql<{ user_id: string }[]>`
    select user_id from player_users where server_key = ${backend.key} and lower(username) = lower(${body.username}) and user_id <> ${userId}`;
  if (taken.length) throw new PlayerAccountError('Someone else on this tagave already uses that account', 409);
  await sql`
    insert into player_users (user_id, server_key, username, password_sealed, source, server_scrobbles)
    values (${userId}, ${backend.key}, ${body.username}, ${sealSecret(password, appSecret())}, 'person', ${body.serverScrobbles})
    on conflict (user_id, server_key) do update set username = excluded.username, password_sealed = excluded.password_sealed,
      server_scrobbles = excluded.server_scrobbles, state = 'active', last_error = null, last_error_at = null, updated_at = now()`;
  // counts seen under another login say nothing about this one
  await sql`delete from player_song_counts where user_id = ${userId} and server_key = ${backend.key}`;
  await sql`delete from player_poll_state where user_id = ${userId} and server_key = ${backend.key}`;
}

export async function removeOwnAccount(sql: Sql, backend: PlayerBackend, userId: string): Promise<void> {
  if (backend.managed !== 'external') throw new PlayerAccountError('The bundled player keeps your account; set or clear a phone password instead');
  await sql`delete from player_users where user_id = ${userId} and server_key = ${backend.key}`;
  await sql`delete from player_song_counts where user_id = ${userId} and server_key = ${backend.key}`;
  await sql`delete from player_poll_state where user_id = ${userId} and server_key = ${backend.key}`;
}

/**
 * Keeps the bundled server's accounts in step with tagave's people: every
 * active person has one, disabled and closed people's are locked, people
 * enabled again are unlocked. Runs every minute; one person's failure is
 * recorded on their row and does not stop the others.
 */
export async function syncBundledUsers(sql: Sql, backend: PlayerBackend, opts: { fetchImpl?: typeof fetch; log?: { warn: (o: object, m: string) => void } } = {}): Promise<{ created: number; locked: number; unlocked: number; retired: number }> {
  const out = { created: 0, locked: 0, unlocked: 0, retired: 0 };
  if (backend.managed !== 'bundled') return out;
  const f = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {};
  const people = await sql<{ id: string; disabled: boolean; state: string | null }[]>`
    select u.id, (u.disabled_at is not null or u.removed_at is not null) as disabled, pu.state
    from users u
    left join player_users pu on pu.user_id = u.id and pu.server_key = ${backend.key}`;
  for (const p of people) {
    try {
      if (!p.disabled && p.state == null) {
        await ensureBundledUser(sql, backend, p.id, opts);
        out.created++;
      } else if (p.disabled && p.state === 'active') {
        await lockOrUnlock(sql, backend, p.id, 'disabled', f);
        out.locked++;
      } else if (!p.disabled && p.state === 'disabled') {
        await lockOrUnlock(sql, backend, p.id, 'active', f);
        out.unlocked++;
      }
    } catch (err) {
      const message = err instanceof NavidromeError || err instanceof PlayerAccountError ? err.message : (err as Error).message;
      opts.log?.warn({ userId: p.id, err: message }, 'player account sync');
      await sql`update player_users set last_error = ${message}, last_error_at = now() where user_id = ${p.id} and server_key = ${backend.key}`;
      // the player itself is down: the next minute tries everyone again
      if (err instanceof NavidromeError && err.httpStatus == null) return out;
    }
  }
  out.retired = await lockRetiredAccounts(sql, backend, f, opts.log);
  return out;
}

/**
 * The accounts of people removed with their data (users.ts › removeUser):
 * a random password nobody knows, then the row goes. An account the server
 * no longer has needs nothing.
 */
async function lockRetiredAccounts(sql: Sql, backend: PlayerBackend, f: { fetchImpl?: typeof fetch }, log?: { warn: (o: object, m: string) => void }): Promise<number> {
  const rows = await sql<{ username: string; server_user_id: string | null }[]>`
    select username, server_user_id from player_retired_accounts where server_key = ${backend.key} order by retired_at`;
  let done = 0;
  for (const r of rows) {
    try {
      let id = r.server_user_id;
      if (!id) id = (await listNavidromeUsers(backend.server, f)).find((u) => u.userName.toLowerCase() === r.username.toLowerCase())?.id ?? null;
      if (id) await updateNavidromeUser(backend.server, id, { password: randomPlayerPassword() }, f);
      await sql`delete from player_retired_accounts where server_key = ${backend.key} and username = ${r.username}`;
      done++;
    } catch (err) {
      const message = (err as Error).message;
      log?.warn({ username: r.username, err: message }, 'player account of a removed person');
      // a 404 from the server: the account is gone already
      if (err instanceof NavidromeError && err.httpStatus === 404) {
        await sql`delete from player_retired_accounts where server_key = ${backend.key} and username = ${r.username}`;
        continue;
      }
      await sql`update player_retired_accounts set last_error = ${message}, last_error_at = now() where server_key = ${backend.key} and username = ${r.username}`;
      if (err instanceof NavidromeError && err.httpStatus == null) break;
    }
  }
  return done;
}

async function lockOrUnlock(sql: Sql, backend: PlayerBackend, userId: string, state: 'active' | 'disabled', f: { fetchImpl?: typeof fetch }): Promise<void> {
  const row = await playerUserRow(sql, userId, backend.key);
  if (!row) return;
  const password = randomPlayerPassword();
  const id = await navidromeId(backend, row, f);
  await updateNavidromeUser(backend.server, id, { password }, f);
  await sql`
    update player_users set password_sealed = ${sealSecret(password, appSecret())}, phone_password = false, state = ${state},
      server_user_id = ${id}, last_error = null, last_error_at = null, updated_at = now()
    where user_id = ${userId} and server_key = ${backend.key}`;
}
