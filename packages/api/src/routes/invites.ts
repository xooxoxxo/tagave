/**
 * Invite and set-password links, opened by someone who is not signed in
 * (public routes; the token is the credential):
 *
 *   GET  /api/v1/invites/:token          what the link is for (404 once used, revoked or expired)
 *   POST /api/v1/invites/:token/accept   { name?, password } → account made or password set, signed in
 *
 * Limited per client address, since the routes need no session.
 */
import type { FastifyInstance } from 'fastify';
import { APIError, fromNodeHeaders } from '@tagave/auth';
import { acceptInviteSchema, type InviteLookup } from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { forwardSetCookies, getAuthHandle, toSessionUser } from '../middleware/auth.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { claimLink, findOpenLink, releaseLink } from '../lib/users.js';

const lookups = new RateLimiter(30, 60_000);
const accepts = new RateLimiter(10, 60_000);

export function resetInviteRouteLimits(): void {
  lookups.reset();
  accepts.reset();
}

const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;
const gone = () => new ApiError(404, 'Not Found', 'This link was already used, was revoked or has expired. Ask the owner for a new one.');

function tokenOf(params: unknown): string {
  const { token } = params as { token: string };
  if (!TOKEN_RE.test(token)) throw gone();
  return token;
}

export async function createInviteRoutes(fastify: FastifyInstance) {
  fastify.get('/invites/:token', async (request): Promise<InviteLookup> => {
    lookups.check(`ip:${request.ip}`);
    const link = await findOpenLink(getAuthHandle().sql, tokenOf(request.params));
    if (!link) throw gone();
    return {
      purpose: link.purpose,
      email: link.email,
      role: link.role,
      name: link.name,
      expiresAt: link.expiresAt.toISOString(),
      clearSecondFactors: link.clearSecondFactors,
    };
  });

  fastify.post('/invites/:token/accept', async (request, reply) => {
    accepts.check(`ip:${request.ip}`);
    const token = tokenOf(request.params);
    const parsed = acceptInviteSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ApiError(400, 'Bad Request', issue?.path[0] === 'password'
        ? 'The password must be 12 to 128 characters.'
        : issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
    }
    const { auth, sql } = getAuthHandle();
    const link = await claimLink(sql, token);
    if (!link) throw gone();
    try {
      if (link.purpose === 'invite') {
        const name = parsed.data.name;
        if (!name) throw new ApiError(400, 'Bad Request', 'name: Enter your name');
        const [taken] = await sql`select 1 from users where lower(email) = ${link.email.toLowerCase()}`;
        if (taken) throw new ApiError(409, 'Conflict', 'An account with this email address exists already. Sign in instead.');
        const res = await auth.api.createInvitedUser({
          body: { email: link.email, password: parsed.data.password, name, role: link.role, signIn: true },
          headers: fromNodeHeaders(request.headers),
          returnHeaders: true,
        });
        forwardSetCookies(reply, res.headers);
        request.log.info({ event: 'users.invite.accepted', userId: res.response.user.id, invite: link.id }, 'invite accepted');
        return reply.status(201).send({ user: toSessionUser(res.response.user) });
      }
      const res = await auth.api.setPasswordAndSignIn({
        body: { userId: link.userId!, password: parsed.data.password, clearSecondFactors: link.clearSecondFactors },
        headers: fromNodeHeaders(request.headers),
        returnHeaders: true,
      });
      if (parsed.data.name) {
        await sql`update users set display_name = ${parsed.data.name}, updated_at = now() where id = ${link.userId!}`;
      }
      forwardSetCookies(reply, res.headers);
      request.log.info({ event: 'users.reset_link.used', userId: link.userId, invite: link.id }, 'set-password link used');
      return reply.status(200).send({ user: toSessionUser({ ...res.response.user, ...(parsed.data.name ? { name: parsed.data.name } : {}) }) });
    } catch (err) {
      // Nothing was made: the person can try again with the same link.
      await releaseLink(sql, link.id);
      if (err instanceof APIError) {
        throw new ApiError(err.statusCode === 403 ? 403 : 400, err.statusCode === 403 ? 'Forbidden' : 'Bad Request', err.message);
      }
      throw err;
    }
  });
}
