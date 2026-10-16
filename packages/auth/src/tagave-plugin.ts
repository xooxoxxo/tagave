import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type postgres from 'postgres';
import * as z from 'zod';
import { revokeAllTrustedDevices } from './trusted-devices.js';

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
      after: [
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
       * every session and trusted device of the account ends, and (when the
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
