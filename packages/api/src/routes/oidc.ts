/**
 * Sign in with your own login service (OpenID Connect). The protocol runs in
 * Better Auth (genericOAuth, @tagave/auth oidc.ts); these routes start its
 * flows with what only the server may decide (which flow, which invite, which
 * session) and keep the settings.
 *
 * Public (sign-in and invite pages):
 *   GET    /api/v1/auth/oidc                      { name }: the button, while it works
 *   POST   /api/v1/auth/oidc/sign-in              { invite? } → { url }
 * Signed in (Account), about their own account:
 *   GET    /api/v1/auth/oidc/link                 linked or not, and whether unlinking is allowed
 *   POST   /api/v1/auth/oidc/link                 → { url }                         (step-up)
 *   DELETE /api/v1/auth/oidc/link                 refused when it is the last way in
 *   POST   /api/v1/auth/step-up/oidc              → { url }: re-verify at the service (prompt=login, max_age=0)
 * Owner (Settings › Users, users.manage):
 *   GET    /api/v1/users/sign-in-service          settings (the secret only as set / not set), redirect URI
 *   PUT    /api/v1/users/sign-in-service          save, then rebuild the auth instance (step-up)
 *   POST   /api/v1/users/sign-in-service/test     { issuer } → what discovery found
 *
 * The service's answer comes back to /api/auth/callback/oidc (routes/betterAuth.ts),
 * which turns every failure into one `?oidc=failed`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  APIError,
  OIDC_PROVIDER_ID,
  OidcConfigError,
  discoverOidc,
  fromNodeHeaders,
  hasLocalWayIn,
  hashInviteToken,
  oidcRedirectUri,
  readOidcSettingsView,
  saveOidcSettings,
  stepUpMethods,
  passkeysCanWork,
  waysIn,
  type OidcFlowData,
} from '@tagave/auth';
import {
  oidcSettingsSchema,
  oidcSignInSchema,
  oidcTestSchema,
  type OidcLinkView,
  type OidcPublicView,
  type OidcSettingsResponse,
  type OidcStartResponse,
  type OidcTestResult,
} from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { forwardSetCookies, getAuthHandle } from '../middleware/auth.js';
import { requirePermission } from '../permissions/guard.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { requireFreshStepUp } from './stepUp.js';

/** Flow starts per client address (sign-in) or person (link, step-up). */
const starts = new RateLimiter(20, 60_000);
const lookups = new RateLimiter(60, 60_000);
/** Settings changes and discovery tests per owner. */
const changes = new RateLimiter(20, 60_000);

export function resetOidcRouteLimits(): void {
  starts.reset();
  lookups.reset();
  changes.reset();
}

const NOT_AVAILABLE = () => new ApiError(404, 'Not Found', 'Sign-in with a login service is not set up here.');

function sameOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (origin !== undefined && !getAuthHandle().env.trustedOrigins.includes(origin)) {
    throw new ApiError(403, 'Forbidden', 'Start this on tagave itself.');
  }
}

function requireSession(request: FastifyRequest): { userId: string; sessionId: string } {
  if (!request.user || !request.sessionId) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  return { userId: request.user.id, sessionId: request.sessionId };
}

/**
 * The service's button works. Starting a flow waits for a due retry (one at
 * a time, shared by every caller, bounded by the discovery time limit).
 */
async function activeName(): Promise<string | null> {
  const status = await getAuthHandle().retryOidc();
  return status.active ? status.name : null;
}

/** The same for a page load: never waits; a due retry runs in the background for the next request. */
export function currentOidcName(): string | null {
  const h = getAuthHandle();
  void h.retryOidc().catch(() => undefined);
  const status = h.oidcStatus();
  return status.active ? status.name : null;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(400, 'Bad Request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
  }
  return parsed.data;
}

/** Better Auth refused to start (provider gone between the check and the call): say only that. */
function startFailed(request: FastifyRequest, err: unknown): never {
  if (err instanceof APIError) {
    request.log.warn({ event: 'auth.oidc.start_failed', status: err.statusCode }, 'login service flow did not start');
    throw new ApiError(503, 'Service Unavailable', 'The login service cannot be reached right now.');
  }
  throw err;
}

async function signInStart(request: FastifyRequest, reply: FastifyReply, flow: OidcFlowData, errorPath: string): Promise<OidcStartResponse> {
  const { auth, env } = getAuthHandle();
  const status = getAuthHandle().oidcStatus();
  const settings = getAuthHandle().oidcSettings();
  try {
    const res = await auth.api.signInSocial({
      body: {
        provider: OIDC_PROVIDER_ID as never,
        callbackURL: `${env.publicUrl.origin}/`,
        errorCallbackURL: `${env.publicUrl.origin}${errorPath}`,
        // Better Auth makes no account unless asked; the gate (oidc.ts) still decides
        requestSignUp: flow.tagaveIntent === 'invite' || Boolean(status.active && settings?.joinEnabled),
        disableRedirect: true,
        additionalData: { ...flow },
      },
      headers: fromNodeHeaders(request.headers),
      returnHeaders: true,
    });
    forwardSetCookies(reply, res.headers);
    const url = (res.response as { url?: string }).url;
    if (!url) throw new ApiError(503, 'Service Unavailable', 'The login service cannot be reached right now.');
    return { url };
  } catch (err) {
    return startFailed(request, err);
  }
}

async function linkStart(
  request: FastifyRequest,
  reply: FastifyReply,
  flow: OidcFlowData,
  paths: { done: string; failed: string },
  additionalParams?: Record<string, string>,
): Promise<OidcStartResponse> {
  const { auth, env } = getAuthHandle();
  try {
    const res = await auth.api.linkSocialAccount({
      body: {
        provider: OIDC_PROVIDER_ID as never,
        callbackURL: `${env.publicUrl.origin}${paths.done}`,
        errorCallbackURL: `${env.publicUrl.origin}${paths.failed}`,
        disableRedirect: true,
        additionalData: { ...flow },
        ...(additionalParams ? { additionalParams } : {}),
      },
      headers: fromNodeHeaders(request.headers),
      returnHeaders: true,
    });
    forwardSetCookies(reply, res.headers);
    const url = (res.response as { url?: string }).url;
    if (!url) throw new ApiError(503, 'Service Unavailable', 'The login service cannot be reached right now.');
    return { url };
  } catch (err) {
    return startFailed(request, err);
  }
}

/** Under /api/v1/auth (public and 'self'). */
export async function createOidcAuthRoutes(fastify: FastifyInstance) {
  fastify.get('/oidc', async (request): Promise<OidcPublicView> => {
    lookups.check(`ip:${request.ip}`);
    return { name: currentOidcName() };
  });

  fastify.post('/oidc/sign-in', async (request, reply): Promise<OidcStartResponse> => {
    sameOrigin(request);
    starts.check(`ip:${request.ip}`);
    const body = parse(oidcSignInSchema, request.body);
    if (!(await activeName())) throw NOT_AVAILABLE();
    if (body.invite) {
      // the invite must still be open and not for an owner (owners keep a password)
      const tokenHash = hashInviteToken(body.invite);
      const [invite] = await getAuthHandle().sql<Array<{ role: string }>>`
        select role from user_invites
         where token_hash = ${tokenHash} and purpose = 'invite' and used_at is null and revoked_at is null and expires_at > now()`;
      if (!invite || invite.role === 'owner') {
        throw new ApiError(404, 'Not Found', 'This link was already used, was revoked or has expired. Ask the owner for a new one.');
      }
      return signInStart(request, reply, { tagaveIntent: 'invite', tagaveInvite: tokenHash }, '/login');
    }
    return signInStart(request, reply, { tagaveIntent: 'sign-in' }, '/login');
  });

  fastify.get('/oidc/link', async (request): Promise<OidcLinkView> => {
    const { userId } = requireSession(request);
    const { sql } = getAuthHandle();
    const [row] = await sql<Array<{ created_at: Date }>>`
      select created_at from auth_accounts where user_id = ${userId} and provider_id = ${OIDC_PROVIDER_ID}`;
    const ways = await waysIn(sql, userId);
    return {
      name: currentOidcName(),
      linked: Boolean(row),
      linkedAt: row ? new Date(row.created_at).toISOString() : null,
      canUnlink: Boolean(row) && hasLocalWayIn(ways),
    };
  });

  fastify.post('/oidc/link', async (request, reply): Promise<OidcStartResponse> => {
    sameOrigin(request);
    const { userId } = requireSession(request);
    starts.check(`user:${userId}`);
    if (!(await activeName())) throw NOT_AVAILABLE();
    const ways = await waysIn(getAuthHandle().sql, userId);
    if (ways.oidc) throw new ApiError(409, 'Conflict', 'Your account is linked already.');
    // a stolen session must not be able to add a way in of its own
    await requireFreshStepUp(request);
    return linkStart(request, reply, { tagaveIntent: 'link' }, { done: '/settings/account?oidc=linked', failed: '/settings/account' });
  });

  fastify.delete('/oidc/link', async (request, reply) => {
    sameOrigin(request);
    const { userId } = requireSession(request);
    starts.check(`user:${userId}`);
    // removing a way in is a sign-in change too: a fresh confirmation first, like linking
    await requireFreshStepUp(request);
    const { sql } = getAuthHandle();
    const done = await sql.begin(async (tx) => {
      // their sign-in rows stay put while this decides
      await tx`select id from users where id = ${userId} for update`;
      const ways = await waysIn(tx as never, userId);
      if (!ways.oidc) return false;
      if (!hasLocalWayIn(ways)) {
        throw new ApiError(409, 'Conflict', 'Add a password or a passkey first: this is your only way to sign in.');
      }
      await tx`delete from auth_accounts where user_id = ${userId} and provider_id = ${OIDC_PROVIDER_ID}`;
      return true;
    });
    if (done) request.log.info({ event: 'auth.oidc.unlinked', userId }, 'login service unlinked');
    return reply.status(204).send();
  });

  fastify.post('/step-up/oidc', async (request, reply): Promise<OidcStartResponse> => {
    sameOrigin(request);
    const { userId, sessionId } = requireSession(request);
    starts.check(`user:${userId}`);
    const { sql, env } = getAuthHandle();
    const active = Boolean(await activeName());
    const methods = await stepUpMethods(sql, userId, passkeysCanWork(env.publicUrl), active);
    if (!methods.includes('oidc')) throw new ApiError(400, 'Bad Request', 'This account cannot confirm with the login service.');
    return linkStart(
      request,
      reply,
      { tagaveIntent: 'step-up', tagaveSession: sessionId, tagaveStartedAt: Date.now() },
      { done: '/auth/oidc-done', failed: '/auth/oidc-done' },
      // sign in again, whatever session the service already has
      { prompt: 'login', max_age: '0' },
    );
  });
}

async function settingsView(): Promise<OidcSettingsResponse> {
  const h = getAuthHandle();
  const status = h.oidcStatus();
  return {
    settings: await readOidcSettingsView(h.sql),
    redirectUri: oidcRedirectUri(h.env.publicUrl.origin),
    active: status.active,
    secretUnreadable: status.secretUnreadable,
  };
}

const putSchema = oidcSettingsSchema.extend({
  /** The issuer changed while people are linked: their links go (an id at one service means nothing at another). */
  unlinkAll: z.boolean().optional(),
});

/** Under /api/v1 behind the session check (users.manage). */
export async function createOidcSettingsRoutes(fastify: FastifyInstance) {
  fastify.get('/users/sign-in-service', async (request): Promise<OidcSettingsResponse> => {
    requirePermission(request, 'users.manage');
    return settingsView();
  });

  fastify.post('/users/sign-in-service/test', async (request): Promise<OidcTestResult> => {
    const actor = requirePermission(request, 'users.manage');
    sameOrigin(request);
    changes.check(actor.id);
    const { issuer } = parse(oidcTestSchema, request.body);
    try {
      const d = await discoverOidc(issuer);
      return {
        issuer: d.issuer,
        authorizationEndpoint: d.authorizationEndpoint,
        tokenEndpoint: d.tokenEndpoint,
        userinfoEndpoint: d.userinfoEndpoint,
        pkceS256: d.pkceS256,
      };
    } catch (err) {
      if (err instanceof OidcConfigError) throw new ApiError(400, 'Bad Request', err.message);
      throw err;
    }
  });

  fastify.put('/users/sign-in-service', async (request): Promise<OidcSettingsResponse> => {
    const actor = requirePermission(request, 'users.manage');
    sameOrigin(request);
    changes.check(actor.id);
    await requireFreshStepUp(request);
    const body = parse(putSchema, request.body);
    const h = getAuthHandle();
    let issuer: string;
    try {
      issuer = (await discoverOidc(body.issuer)).issuer;
    } catch (err) {
      if (err instanceof OidcConfigError) throw new ApiError(400, 'Bad Request', err.message);
      throw err;
    }
    const before = await readOidcSettingsView(h.sql);
    if (before && before.issuer !== issuer) {
      const [{ n } = { n: 0 }] = await h.sql<Array<{ n: number }>>`
        select count(*)::int as n from auth_accounts where provider_id = ${OIDC_PROVIDER_ID}`;
      if (n > 0 && !body.unlinkAll) {
        throw new ApiError(409, 'Conflict', `${n} ${n === 1 ? 'person is' : 'people are'} linked to the old issuer. Saving unlinks them.`);
      }
      if (n > 0) {
        // the old service is off first, so no sign-in through it lands while its links go
        await h.suspendOidc();
        await h.sql`delete from auth_accounts where provider_id = ${OIDC_PROVIDER_ID}`;
        request.log.info({ event: 'auth.oidc.unlinked_all', actor: actor.id, count: n }, 'login service changed: links removed');
      }
    }
    await saveOidcSettings(h.sql, h.env.appSecret, {
      name: body.name,
      issuer,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      enabled: body.enabled,
      joinEnabled: body.joinEnabled,
      joinGroup: body.joinGroup?.trim() ? body.joinGroup.trim() : null,
    }, actor.id);
    const status = await h.reload();
    request.log.info({
      event: 'auth.oidc.settings_saved', actor: actor.id, enabled: body.enabled, joinEnabled: body.joinEnabled,
      joinGroup: Boolean(body.joinGroup?.trim()), secret: body.clientSecret === undefined ? 'kept' : body.clientSecret === null ? 'none' : 'set',
      active: status.active,
    }, 'login service saved');
    return settingsView();
  });
}
