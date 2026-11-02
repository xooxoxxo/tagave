import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies';
import type postgres from 'postgres';
import * as z from 'zod';
import { revokeAllTrustedDevices } from './trusted-devices.js';
import { OIDC_PROVIDER_ID, waysIn } from './oidc.js';

/** Deleting this passkey would leave the account no way in (or an owner only the login service). */
export const LAST_WAY_IN = 'LAST_WAY_IN';

/** The two-factor plugin's cookies and lifetime (better-auth/plugins/two-factor, unchanged defaults). */
const TWO_FACTOR_COOKIE = 'two_factor';
const TRUST_DEVICE_COOKIE = 'trust_device';
const TWO_FACTOR_MAX_AGE_S = 600;
const TRUST_DEVICE_MAX_AGE_S = 30 * 24 * 60 * 60;

type HookCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * The two-factor plugin's trusted-device check, as its sign-in hook runs it:
 * a signed `trust_device` cookie whose HMAC and stored record match this
 * person. A match is used up and replaced (the cookie rotates).
 */
async function trustedDevice(ctx: HookCtx, userId: string): Promise<boolean> {
  const attrs = ctx.context.createAuthCookie(TRUST_DEVICE_COOKIE, { maxAge: TRUST_DEVICE_MAX_AGE_S });
  const value = await ctx.getSignedCookie(attrs.name, ctx.context.secret);
  if (!value) return false;
  const [token, trustIdentifier] = value.split('!');
  if (!token || !trustIdentifier) return false;
  const sign = (id: string) => createHmac('sha256', ctx.context.secret).update(`${userId}!${id}`).digest('base64url');
  const expected = Buffer.from(sign(trustIdentifier));
  const got = Buffer.from(token);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return false;
  const record = await ctx.context.internalAdapter.findVerificationValue(trustIdentifier);
  if (!record || record.value !== userId || new Date(record.expiresAt) <= new Date()) return false;
  await ctx.context.internalAdapter.deleteVerificationByIdentifier(trustIdentifier);
  const next = `trust-device-${randomBytes(24).toString('base64url')}`;
  await ctx.context.internalAdapter.createVerificationValue({ value: userId, identifier: next, expiresAt: new Date(Date.now() + TRUST_DEVICE_MAX_AGE_S * 1000) });
  await ctx.setSignedCookie(attrs.name, `${sign(next)}!${next}`, ctx.context.secret, attrs.attributes);
  return true;
}

function checkPasswordLength(config: { minPasswordLength: number; maxPasswordLength: number }, password: string): void {
  if (password.length < config.minPasswordLength) {
    throw new APIError('BAD_REQUEST', { message: `The password must be at least ${config.minPasswordLength} characters.` });
  }
  if (password.length > config.maxPasswordLength) {
    throw new APIError('BAD_REQUEST', { message: `The password must be at most ${config.maxPasswordLength} characters.` });
  }
}

/**
 * tagave's server-only Better Auth endpoints. None of them is on the HTTP
 * router (`serverOnly`): the api calls them through `auth.api.*` so that the
 * session cookie is set by Better Auth's own code, exactly like a sign-in.
 */
export const tagavePlugin = (sql: postgres.Sql, rpId: string) =>
  ({
    id: 'tagave',
    hooks: {
      before: [
        {
          // The last passkey of an account without a password: refused when
          // nothing else is left, and for an owner when only the login
          // service would be (an owner keeps a password or a passkey).
          // The check and the delete run in one transaction holding the
          // person's row, so two deletes at once cannot both pass it; the
          // hook answers in place of the passkey plugin's own endpoint.
          matcher: (ctx) => ctx.path === '/passkey/delete-passkey',
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            const id = (ctx.body as { id?: unknown } | undefined)?.id;
            if (typeof id !== 'string' || !id) return;
            const userId = session.user.id;
            const owner = (session.user as { role?: unknown }).role === 'owner';
            const deleted = await sql.begin(async (tx) => {
              await tx`select id from users where id = ${userId} for update`;
              const [mine] = await tx`select 1 from auth_passkeys where id = ${id} and user_id = ${userId}`;
              if (!mine) return false;
              const ways = await waysIn(tx as unknown as postgres.Sql, userId);
              if (!ways.password && ways.passkeys <= 1 && (owner || !ways.oidc)) {
                throw new APIError('BAD_REQUEST', {
                  code: LAST_WAY_IN,
                  message: owner
                    ? 'An owner keeps a password or a passkey. Add another passkey first.'
                    : 'This is your only way to sign in. Add another passkey first.',
                });
              }
              await tx`delete from auth_passkeys where id = ${id} and user_id = ${userId}`;
              return true;
            });
            if (!deleted) throw new APIError('NOT_FOUND', { code: 'PASSKEY_NOT_FOUND', message: 'Passkey not found' });
            return ctx.json({ status: true });
          }),
        },
      ],
      after: [
        {
          // A sign-in through the login service asks for the authenticator
          // code exactly like a password sign-in (twoFactor's own hook covers
          // only the credential paths): no session yet, a two_factor cookie,
          // and /login/2fa. A trusted device skips it, as it does there.
          matcher: (ctx) => ctx.path === '/callback/:id',
          handler: createAuthMiddleware(async (ctx) => {
            const data = ctx.context.newSession;
            if (!data) return;
            const userId = data.user.id;
            const [tf] = await sql`
              select 1 from users u join auth_two_factors t on t.user_id = u.id
               where u.id = ${userId} and u.two_factor_enabled and t.verified is not false`;
            if (!tf) return;
            if (await trustedDevice(ctx, userId)) return;
            deleteSessionCookie(ctx, true);
            await ctx.context.internalAdapter.deleteSession(data.session.token);
            ctx.context.setNewSession(null);
            const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE, { maxAge: TWO_FACTOR_MAX_AGE_S });
            const identifier = `2fa-${randomBytes(15).toString('base64url')}`;
            const expiresAt = new Date(Date.now() + TWO_FACTOR_MAX_AGE_S * 1000);
            await ctx.context.internalAdapter.createVerificationValue({ value: userId, identifier, expiresAt });
            await ctx.context.internalAdapter.createVerificationValue({ value: '0', identifier: `2fa-attempts-${identifier}`, expiresAt });
            await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes);
            return ctx.redirect(`${new URL(ctx.context.baseURL).origin}/login/2fa`);
          }),
        },
        {
          // Turning the authenticator off or changing the password forgets
          // every trusted device (Better Auth itself forgets only the current
          // browser's), so the next sign-in anywhere asks again.
          matcher: (ctx) => ctx.path === '/two-factor/disable' || ctx.path === '/change-password',
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (returned instanceof Error || (returned instanceof Response && !returned.ok)) return;
            const userId = ctx.context.session?.user.id;
            if (userId) await revokeAllTrustedDevices(sql, userId);
          }),
        },
        {
          // Remember which host a new passkey is bound to (tagave-doctor
          // compares it with PUBLIC_URL).
          matcher: (ctx) => ctx.path === '/passkey/verify-registration',
          handler: createAuthMiddleware(async (ctx) => {
            const userId = ctx.context.session?.user.id;
            if (userId) await sql`update auth_passkeys set rp_id = ${rpId} where user_id = ${userId} and rp_id is null`;
          }),
        },
      ],
    },
    endpoints: {
      /**
       * The one-release session bridge: a valid 0.6.x `sessionId` becomes a
       * Better Auth session for the same user. The new session keeps the
       * legacy created_at, so it is never "fresher" than the sign-in it
       * replaces.
       */
      bridgeLegacySession: createAuthEndpoint.serverOnly(
        {
          method: 'POST',
          body: z.object({ userId: z.string(), createdAt: z.coerce.date() }),
        },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (!user) throw new APIError('UNAUTHORIZED', { message: 'user not found' });
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            false,
            { createdAt: ctx.body.createdAt },
            true,
          );
          if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'could not create a session' });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ sessionId: session.id, token: session.token });
        },
      ),

      /**
       * First-run owner account. HTTP sign-up stays disabled
       * (`disableSignUp`, which also refuses `auth.api.signUpEmail`), so
       * setup creates the user, its credential account and its first session
       * here. The api calls it only while holding the setup lock and after
       * checking that no user exists.
       */
      createOwner: createAuthEndpoint.serverOnly(
        {
          method: 'POST',
          body: z.object({ email: z.string(), password: z.string(), name: z.string() }),
        },
        async (ctx) => {
          const { email, password, name } = ctx.body;
          checkPasswordLength(ctx.context.password.config, password);
          const hash = await ctx.context.password.hash(password);
          const user = await ctx.context.internalAdapter.createUser({
            email: email.toLowerCase(),
            name,
            emailVerified: true,
            role: 'owner',
          }, { method: 'admin' });
          await ctx.context.internalAdapter.linkAccount({
            userId: user.id,
            providerId: 'credential',
            accountId: user.id,
            password: hash,
          });
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'could not create a session' });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ user, sessionId: session.id });
        },
      ),

      /**
       * An accepted invite (Settings › Users): the account, its password and
       * its first session, like createOwner but with the invite's role. The
       * api calls it only after taking the invite row (one use), so the link
       * is what authorises it.
       */
      createInvitedUser: createAuthEndpoint.serverOnly(
        {
          method: 'POST',
          body: z.object({
            email: z.string(),
            password: z.string(),
            name: z.string(),
            role: z.enum(['owner', 'editor', 'listener']),
            signIn: z.boolean().default(true),
          }),
        },
        async (ctx) => {
          const { email, password, name, role, signIn } = ctx.body;
          checkPasswordLength(ctx.context.password.config, password);
          const hash = await ctx.context.password.hash(password);
          const user = await ctx.context.internalAdapter.createUser({
            email: email.toLowerCase(),
            name,
            emailVerified: true,
            role,
          }, { method: 'admin' });
          await ctx.context.internalAdapter.linkAccount({
            userId: user.id,
            providerId: 'credential',
            accountId: user.id,
            password: hash,
          });
          if (!signIn) return ctx.json({ user, sessionId: null });
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'could not create a session' });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ user, sessionId: session.id });
        },
      ),

      /**
       * A used set-password link: the new password replaces the old one,
       * every session and trusted device of the account ends, the login
       * service is unlinked, and (when the
       * owner asked) the authenticator app and passkeys go too. Then this
       * browser is signed in.
       */
      setPasswordAndSignIn: createAuthEndpoint.serverOnly(
        {
          method: 'POST',
          body: z.object({ userId: z.string(), password: z.string(), clearSecondFactors: z.boolean() }),
        },
        async (ctx) => {
          const { userId, password, clearSecondFactors } = ctx.body;
          checkPasswordLength(ctx.context.password.config, password);
          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user) throw new APIError('NOT_FOUND', { message: 'user not found' });
          const hash = await ctx.context.password.hash(password);
          const accounts = await ctx.context.internalAdapter.findAccounts(userId);
          if (accounts.some((a) => a.providerId === 'credential')) {
            await ctx.context.internalAdapter.updatePassword(userId, hash);
          } else {
            await ctx.context.internalAdapter.linkAccount({ userId, providerId: 'credential', accountId: userId, password: hash });
          }
          await ctx.context.internalAdapter.deleteUserSessions(userId);
          await revokeAllTrustedDevices(sql, userId);
          // Every reset unlinks the login service: an identity someone else
          // linked to this account must not keep a way in. The person links
          // their own again from Account.
          await sql`delete from auth_accounts where user_id = ${userId} and provider_id = ${OIDC_PROVIDER_ID}`;
          if (clearSecondFactors) {
            await sql`delete from auth_two_factors where user_id = ${userId}`;
            await sql`delete from auth_passkeys where user_id = ${userId}`;
            await sql`update users set two_factor_enabled = false where id = ${userId}`;
          }
          const fresh = (await ctx.context.internalAdapter.findUserById(userId)) ?? user;
          const session = await ctx.context.internalAdapter.createSession(userId);
          if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'could not create a session' });
          await setSessionCookie(ctx, { session, user: fresh });
          return ctx.json({ user: fresh, sessionId: session.id });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
