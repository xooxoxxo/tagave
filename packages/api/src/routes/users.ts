/**
 * Settings › Users (owner, permission users.manage):
 *
 *   GET    /api/v1/users                          people + open links
 *   POST   /api/v1/users/invites                  { email, role } → one-time link   (step-up)
 *   DELETE /api/v1/users/invites/:inviteId        revoke a link
 *   PATCH  /api/v1/users/:userId                  { role?, disabled? }              (step-up)
 *   POST   /api/v1/users/:userId/reset-sign-in    { clearSecondFactors } → link     (step-up)
 *   DELETE /api/v1/users/:userId                  { data: 'keep' | 'delete' }        (step-up)
 *
 * The rules (at least one owner, nobody turns off or removes themselves)
 * live in lib/users.ts. Links are shown once; only their hash is stored.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  createInviteSchema, patchUserSchema, removeUserSchema, resetSignInSchema,
  type InviteLinkResponse, type UsersOverview,
} from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { requirePermission } from '../permissions/guard.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { changeUser, createLink, inviteLink, listUsers, removeUser, resetLinkFor, revokeInvite } from '../lib/users.js';
import { requireFreshStepUp } from './stepUp.js';

/** Per owner: 30 changes a minute is far past any hand. */
const changes = new RateLimiter(30, 60_000);

export function resetUserRouteLimits(): void {
  changes.reset();
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(400, 'Bad Request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
  }
  return parsed.data;
}

async function sensitive(request: FastifyRequest) {
  const user = requirePermission(request, 'users.manage');
  changes.check(user.id);
  await requireFreshStepUp(request);
  return user;
}

export async function createUserRoutes(fastify: FastifyInstance) {
  fastify.get('/users', async (request): Promise<UsersOverview> => {
    const user = requirePermission(request, 'users.manage');
    return listUsers(getAuthHandle().sql, user.id);
  });

  fastify.post('/users/invites', async (request, reply) => {
    const actor = await sensitive(request);
    const body = parse(createInviteSchema, request.body);
    const { sql, env } = getAuthHandle();
    const { invite, token } = await createLink(sql, { purpose: 'invite', email: body.email, role: body.role, createdBy: actor.id });
    request.log.info({ event: 'users.invite.created', actor: actor.id, invite: invite.id, role: invite.role }, 'invite created');
    return reply.status(201).send({ invite, link: inviteLink(env.publicUrl.origin, token) } satisfies InviteLinkResponse);
  });

  fastify.delete('/users/invites/:inviteId', async (request, reply) => {
    const actor = requirePermission(request, 'users.manage');
    changes.check(actor.id);
    const { inviteId } = request.params as { inviteId: string };
    await revokeInvite(getAuthHandle().sql, inviteId);
    request.log.info({ event: 'users.invite.revoked', actor: actor.id, invite: inviteId }, 'invite revoked');
    return reply.status(204).send();
  });

  fastify.patch('/users/:userId', async (request, reply) => {
    const actor = await sensitive(request);
    const { userId } = request.params as { userId: string };
    const body = parse(patchUserSchema, request.body);
    await changeUser(getAuthHandle().sql, actor.id, userId, body);
    request.log.info({ event: 'users.changed', actor: actor.id, userId, ...body }, 'user changed');
    return reply.status(204).send();
  });

  fastify.post('/users/:userId/reset-sign-in', async (request, reply) => {
    const actor = await sensitive(request);
    const { userId } = request.params as { userId: string };
    const body = parse(resetSignInSchema, request.body);
    const { sql, env } = getAuthHandle();
    const { invite, token } = await resetLinkFor(sql, userId, body.clearSecondFactors, actor.id);
    request.log.info({ event: 'users.reset_link.created', actor: actor.id, userId, invite: invite.id }, 'set-password link created');
    return reply.status(201).send({ invite, link: inviteLink(env.publicUrl.origin, token) } satisfies InviteLinkResponse);
  });

  fastify.delete('/users/:userId', async (request, reply) => {
    const actor = await sensitive(request);
    const { userId } = request.params as { userId: string };
    const body = parse(removeUserSchema, request.body);
    await removeUser(getAuthHandle().sql, actor.id, userId, body.data);
    request.log.info({ event: 'users.removed', actor: actor.id, userId, data: body.data }, 'user removed');
    return reply.status(204).send();
  });
}
