/**
 * Test users with a role and a signed-in session, for DB tests:
 *
 *   const { cookie, userId } = await createTestUser(handle, { role: 'listener' });
 *   await app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie } });
 *
 * Made through the same server-only Better Auth endpoint an accepted invite
 * uses (createInvitedUser), so the session is a real one.
 */
import { randomUUID } from 'node:crypto';
import type { AuthHandle } from '@tagave/auth';
import type { Role } from '@tagave/shared';
import { cookieHeader, cookieJar } from './authApp.js';

export const TEST_USER_PASSWORD = 'correct horse battery staple';

export interface TestUser {
  userId: string;
  email: string;
  password: string;
  role: Role;
  /** A ready `Cookie` header value. */
  cookie: string;
  jar: Record<string, string>;
}

export async function createTestUser(
  handle: AuthHandle,
  opts: { role: Role; email?: string; password?: string; name?: string },
): Promise<TestUser> {
  const email = opts.email ?? `${opts.role}-${randomUUID().slice(0, 8)}@example.test`;
  const password = opts.password ?? TEST_USER_PASSWORD;
  const res = await handle.auth.api.createInvitedUser({
    body: { email, password, name: opts.name ?? `${opts.role} person`, role: opts.role, signIn: true },
    returnHeaders: true,
  });
  const jar = cookieJar(res.headers.getSetCookie());
  return { userId: res.response.user.id, email, password, role: opts.role, cookie: cookieHeader(jar), jar };
}
