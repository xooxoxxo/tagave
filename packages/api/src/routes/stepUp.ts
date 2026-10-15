/**
 * Step-up for sensitive one-time actions (today: starting an in-app update).
 * The rules live in @tagave/auth (step-up.ts); this file is the HTTP side and
 * the guard routes call.
 *
 *   GET  /api/v1/auth/step-up                   fresh or not, and the methods this account has
 *   POST /api/v1/auth/step-up/passkey/options   WebAuthn options (challenge kept server-side)
 *   POST /api/v1/auth/step-up/passkey           { response }
 *   POST /api/v1/auth/step-up/totp              { code }
 *   POST /api/v1/auth/step-up/password          { password }  (accounts with no second factor)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  STEP_UP_WINDOW_MS,
  isFresh,
  lastVerifiedAt,
  passkeyStepUpOptions,
  passkeysCanWork,
  recordStepUp,
  stepUpMethods,
  verifyPasskeyStepUp,
  verifyPasswordStepUp,
  verifyTotpStepUp,
  type StepUpMethod,
} from '@tagave/auth';
import type { StepUpStatus } from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';

export const STEP_UP_REQUIRED = 'Step-up required';

/** Wrong answers allowed per user before re-verification pauses for LOCK_MS. */
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; since: number }>();

function requireSession(request: FastifyRequest): { userId: string; sessionId: string } {
  if (!request.user || !request.sessionId) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  return { userId: request.user.id, sessionId: request.sessionId };
}

async function status(userId: string, sessionId: string): Promise<StepUpStatus> {
  const { sql, env } = getAuthHandle();
  const at = (await lastVerifiedAt(sql, sessionId)) ?? new Date(0);
  return {
    verifiedAt: at.toISOString(),
    freshUntil: new Date(at.getTime() + STEP_UP_WINDOW_MS).toISOString(),
    fresh: isFresh(at),
    methods: await stepUpMethods(sql, userId, passkeysCanWork(env.publicUrl)),
  };
}

/**
 * The guard: throws 403 "Step-up required" unless this session signed in or
 * re-verified within the last five minutes.
 */
export async function requireFreshStepUp(request: FastifyRequest): Promise<void> {
  const { sessionId } = requireSession(request);
  const at = await lastVerifiedAt(getAuthHandle().sql, sessionId);
  if (!isFresh(at)) {
    throw new ApiError(403, STEP_UP_REQUIRED, 'Confirm it is you first: this action needs a sign-in or a re-verification from the last five minutes.');
  }
}

function checkLock(userId: string): void {
  const f = failures.get(userId);
  if (f && f.count >= MAX_FAILURES && Date.now() - f.since < LOCK_MS) {
    throw new ApiError(429, 'Too Many Requests', 'Too many wrong answers. Try again in 15 minutes.');
  }
  if (f && Date.now() - f.since >= LOCK_MS) failures.delete(userId);
}

function noteFailure(userId: string): void {
  const f = failures.get(userId);
  if (f) f.count++;
  else failures.set(userId, { count: 1, since: Date.now() });
}

/** Test hook: forget wrong answers. */
export function resetStepUpFailures(): void {
  failures.clear();
}

async function finish(
  request: FastifyRequest,
  reply: FastifyReply,
  method: StepUpMethod,
  check: (userId: string, sessionId: string) => Promise<boolean>,
) {
  const { userId, sessionId } = requireSession(request);
  checkLock(userId);
  const { sql, env } = getAuthHandle();
  const methods = await stepUpMethods(sql, userId, passkeysCanWork(env.publicUrl));
  if (!methods.includes(method)) {
    throw new ApiError(400, 'Bad Request', method === 'password'
      ? 'This account has a passkey or an authenticator app; confirm with one of those.'
      : `This account cannot confirm with ${method === 'totp' ? 'an authenticator code' : 'a passkey'}.`);
  }
  if (!(await check(userId, sessionId))) {
    noteFailure(userId);
    request.log.warn({ event: 'auth.step_up.failed', userId, method }, 'step-up failed');
    throw new ApiError(401, 'Unauthorized', method === 'passkey' ? 'The passkey was not accepted.' : method === 'totp' ? 'That code is not right.' : 'That password is not right.');
  }
  failures.delete(userId);
  await recordStepUp(sql, sessionId, userId, method);
  request.log.info({ event: 'auth.step_up', userId, method }, 'step-up');
  return reply.send(await status(userId, sessionId));
}

const codeSchema = z.object({ code: z.string().min(1).max(20) }).strict();
const passwordSchema = z.object({ password: z.string().min(1).max(1024) }).strict();
const passkeySchema = z.object({ response: z.object({ id: z.string().min(1).max(1024) }).passthrough() }).strict();

export async function createStepUpRoutes(fastify: FastifyInstance) {
  fastify.get('/step-up', async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId, sessionId } = requireSession(request);
    return reply.send(await status(userId, sessionId));
  });

  fastify.post('/step-up/passkey/options', async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId, sessionId } = requireSession(request);
    const { sql, env } = getAuthHandle();
    if (!passkeysCanWork(env.publicUrl)) throw new ApiError(400, 'Bad Request', 'Passkeys need https (or localhost) at PUBLIC_URL.');
    return reply.send(await passkeyStepUpOptions(sql, { rpID: env.publicUrl.hostname, userId, sessionId }));
  });

  fastify.post('/step-up/passkey', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = passkeySchema.parse(request.body ?? {});
    const { sql, env } = getAuthHandle();
    return finish(request, reply, 'passkey', (userId, sessionId) =>
      verifyPasskeyStepUp(sql, {
        rpID: env.publicUrl.hostname,
        origin: env.publicUrl.origin,
        userId,
        sessionId,
        response: body.response as never,
      }));
  });

  fastify.post('/step-up/totp', async (request: FastifyRequest, reply: FastifyReply) => {
    const { code } = codeSchema.parse(request.body ?? {});
    const { sql, env } = getAuthHandle();
    return finish(request, reply, 'totp', (userId) => verifyTotpStepUp(sql, env.appSecret, userId, code));
  });

  fastify.post('/step-up/password', async (request: FastifyRequest, reply: FastifyReply) => {
    const { password } = passwordSchema.parse(request.body ?? {});
    const { sql } = getAuthHandle();
    return finish(request, reply, 'password', (userId) => verifyPasswordStepUp(sql, userId, password));
  });
}
