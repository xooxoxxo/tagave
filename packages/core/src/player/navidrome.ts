/**
 * Navidrome's own REST API, for the one thing Subsonic cannot do: manage
 * users. tagave signs in as the bundled server's admin (POST /auth/login
 * gives a JWT, sent back in x-nd-authorization) and keeps one Navidrome user
 * per tagave person, so plays, play counts, ratings and stars are theirs.
 *
 * Navidrome marks this API "not ready" for third parties; tagave uses only
 * /auth/login and /api/user, pins the image per release, and its tests run
 * against the pinned version. Navidrome has no "disabled" flag: a user is
 * locked by giving it a new random password nobody knows.
 */
import { randomBytes } from 'node:crypto';
import { baseUrl, type SubsonicServer } from './subsonic.js';

export class NavidromeError extends Error {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'NavidromeError';
    this.httpStatus = httpStatus;
  }
}

export interface NavidromeUser {
  id: string;
  userName: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

type Opts = { fetchImpl?: typeof fetch; timeoutMs?: number };

/** JWTs by server + user, reused until Navidrome refuses one (they last two days). */
const tokens = new Map<string, string>();

export function clearNavidromeTokens(): void {
  tokens.clear();
}

async function request(url: string, init: RequestInit, opts: Opts): Promise<Response> {
  try {
    return await (opts.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  } catch (err) {
    const e = err as Error;
    throw new NavidromeError(e.name === 'TimeoutError' ? `Navidrome at ${url.split('/api')[0]} did not answer in time` : `Navidrome could not be reached (${e.message})`);
  }
}

export async function navidromeLogin(server: SubsonicServer, opts: Opts = {}): Promise<string> {
  const res = await request(`${baseUrl(server)}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: server.username, password: server.password }),
  }, opts);
  if (res.status === 401) throw new NavidromeError('Navidrome refused the admin user name or password', 401);
  if (!res.ok) throw new NavidromeError(`Navidrome answered ${res.status} to the sign-in`, res.status);
  const body = (await res.json().catch(() => null)) as { token?: unknown; isAdmin?: unknown } | null;
  if (!body || typeof body.token !== 'string') throw new NavidromeError('Navidrome did not send a sign-in token');
  if (body.isAdmin !== true) throw new NavidromeError('The player account tagave uses is not a Navidrome admin');
  return body.token;
}

/** One call to /api/…, signing in first (and once more when the saved token has expired). */
async function api(server: SubsonicServer, method: string, path: string, body: unknown, opts: Opts): Promise<unknown> {
  const key = `${baseUrl(server)}|${server.username}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let token = tokens.get(key);
    if (!token) {
      token = await navidromeLogin(server, opts);
      tokens.set(key, token);
    }
    const res = await request(`${baseUrl(server)}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-nd-authorization': `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, opts);
    if (res.status === 401 && attempt === 0) {
      tokens.delete(key);
      continue;
    }
    // Navidrome sends a fresh token with each answer; keep the newest
    const fresh = res.headers.get('x-nd-authorization');
    if (fresh?.startsWith('Bearer ')) tokens.set(key, fresh.slice(7));
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as { error?: unknown; errors?: Record<string, unknown> };
        if (parsed.errors) message = Object.entries(parsed.errors).map(([k, v]) => `${k}: ${String(v)}`).join(', ');
        else if (typeof parsed.error === 'string') message = parsed.error;
      } catch { /* not JSON */ }
      throw new NavidromeError(`Navidrome refused ${method} ${path}: ${message || res.status}`, res.status);
    }
    return text ? JSON.parse(text) : null;
  }
  throw new NavidromeError('Navidrome kept refusing the admin sign-in', 401);
}

function toUser(raw: Record<string, unknown>): NavidromeUser {
  return {
    id: String(raw['id']),
    userName: String(raw['userName'] ?? ''),
    name: String(raw['name'] ?? ''),
    email: String(raw['email'] ?? ''),
    isAdmin: raw['isAdmin'] === true,
  };
}

export async function listNavidromeUsers(admin: SubsonicServer, opts: Opts = {}): Promise<NavidromeUser[]> {
  const list = (await api(admin, 'GET', '/api/user?_end=1000', undefined, opts)) as Array<Record<string, unknown>> | null;
  return (list ?? []).map(toUser);
}

/** A regular (not admin) user; Navidrome gives it the libraries marked for new users. */
export async function createNavidromeUser(admin: SubsonicServer, user: { userName: string; name: string; password: string }, opts: Opts = {}): Promise<string> {
  const made = (await api(admin, 'POST', '/api/user', { userName: user.userName, name: user.name, email: '', password: user.password, isAdmin: false }, opts)) as { id?: unknown } | null;
  if (!made || typeof made.id !== 'string') throw new NavidromeError('Navidrome did not say which user it created');
  return made.id;
}

/** Sets a user's password (and display name). Navidrome's PUT takes the whole user. */
export async function updateNavidromeUser(admin: SubsonicServer, id: string, patch: { password?: string; name?: string }, opts: Opts = {}): Promise<void> {
  const current = (await api(admin, 'GET', `/api/user/${encodeURIComponent(id)}`, undefined, opts)) as Record<string, unknown> | null;
  if (!current) throw new NavidromeError('Navidrome does not have that user', 404);
  const { libraries: _libraries, ...rest } = current;
  await api(admin, 'PUT', `/api/user/${encodeURIComponent(id)}`, { ...rest, ...(patch.name ? { name: patch.name } : {}), ...(patch.password ? { password: patch.password } : {}) }, opts);
}

/** A password nobody types: 24 random bytes. */
export function randomPlayerPassword(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * A Navidrome user name for a person: ASCII letters, digits, dot, dash and
 * underscore, from their display name or the part of their email before the
 * @. Never "admin", never empty.
 */
export function playerUserName(person: { displayName?: string | null; email?: string | null }): string {
  const from = (person.displayName?.trim() || person.email?.split('@')[0] || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let name = from.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').replace(/-{2,}/g, '-').slice(0, 24).replace(/[-._]+$/, '');
  if (!name || name === 'admin') name = name ? 'admin-person' : 'listener';
  return name;
}

/** The name with -2, -3, … until it is not taken (compared without case). */
export function freePlayerUserName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 21)}-${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base.slice(0, 16)}-${randomBytes(3).toString('hex')}`;
}
