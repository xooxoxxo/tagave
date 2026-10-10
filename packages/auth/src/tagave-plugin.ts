import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type postgres from 'postgres';
import * as z from 'zod';
import { revokeAllTrustedDevices } from './trusted-devices.js';

/**
 * tagave's server-only Better Auth endpoints. None of them is on the HTTP
 * router (`serverOnly`): the api calls them through `auth.api.*` so that the
 * session cookie is set by Better Auth's own code, exactly like a sign-in.
 */
export const tagavePlugin = (sql: postgres.Sql) =>
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
          const { minPasswordLength, maxPasswordLength } = ctx.context.password.config;
          if (password.length < minPasswordLength) {
            throw new APIError('BAD_REQUEST', { message: `The password must be at least ${minPasswordLength} characters.` });
          }
          if (password.length > maxPasswordLength) {
            throw new APIError('BAD_REQUEST', { message: `The password must be at most ${maxPasswordLength} characters.` });
          }
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
    },
  }) satisfies BetterAuthPlugin;
