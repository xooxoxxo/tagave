/**
 * Settings › Updates, when the opt-in updater runs (compose profile
 * "updater", TAGAVE_UPDATER_URL set): the app talks to it over the internal
 * network, signing every call with a key derived from APP_SECRET.
 *
 *   GET  /api/v1/updater          owner: is it installed and reachable, and its current or last run
 *   POST /api/v1/updater/update   owner + fresh step-up: { version } starts an update
 *
 * The updater holds the state of a run, so the page keeps polling the GET
 * while the app restarts and picks the run up again afterwards.
 *
 * And for the updater (no session, signed by it instead):
 *
 *   GET  /api/v1/internal/updater/versions   the app's version and the live workers' heartbeats
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readBuildInfo } from '@tagave/core';
import { startUpdateSchema, type UpdateRun, type UpdaterStatus, type UpdaterView } from '@tagave/shared';
import { SIGNATURE_HEADER, SignatureVerifier, TIME_HEADER, signRequest } from '@tagave/updater/token';
import { ApiError } from '../middleware/errorHandler.js';
import { liveWorkers } from './updates.js';
import { requireFreshStepUp } from './stepUp.js';

const CALL_TIMEOUT_MS = 8000;

export function updaterUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env['TAGAVE_UPDATER_URL']?.trim();
  return raw ? raw.replace(/\/$/, '') : null;
}

function appSecret(): string {
  const s = process.env['APP_SECRET'];
  if (!s) throw new ApiError(500, 'Internal Server Error', 'APP_SECRET is not set');
  return s;
}

/** `restarting`: the updater refused because it is replacing itself on a new version (409). */
type CallResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number; error: string; restarting?: boolean };

/** The title of the 409 the page shows as "restarting the updater". */
const UPDATER_RESTARTING_TITLE = 'Updater restarting';

async function callUpdater<T>(base: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<CallResult<T>> {
  const text = body === undefined ? '' : JSON.stringify(body);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...signRequest(appSecret(), method, path, text), ...(text ? { 'content-type': 'application/json' } : {}) },
      ...(text ? { body: text } : {}),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string; selfReplace?: unknown };
    if (!res.ok) {
      const error = json.error ?? `the updater answered ${res.status}`;
      return res.status === 409 && json.selfReplace ? { ok: false, status: 409, error, restarting: true } : { ok: false, status: res.status, error };
    }
    return { ok: true, status: res.status, body: json };
  } catch (err) {
    return { ok: false, status: 502, error: `the updater does not answer at ${base} (${(err as Error).message})` };
  }
}

function requireOwner(request: FastifyRequest) {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  if (request.user.role !== 'owner') throw new ApiError(403, 'Forbidden', 'Only the owner can update tagave');
  return request.user;
}

export async function createUpdaterRoutes(fastify: FastifyInstance) {
  fastify.get('/updater', async (request: FastifyRequest, reply: FastifyReply) => {
    requireOwner(request);
    const base = updaterUrl();
    if (!base) return reply.send({ installed: false, reachable: false, error: null, updater: null } satisfies UpdaterView);
    const res = await callUpdater<UpdaterStatus>(base, 'GET', '/v1/status');
    return reply.send((res.ok
      ? { installed: true, reachable: true, error: null, updater: res.body }
      : { installed: true, reachable: false, error: res.error, updater: null }) satisfies UpdaterView);
  });

  fastify.post('/updater/update', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireOwner(request);
    const parsed = startUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'Invalid body');
    const base = updaterUrl();
    if (!base) throw new ApiError(409, 'Conflict', 'The updater is not installed on this server');
    await requireFreshStepUp(request);
    const res = await callUpdater<{ run: UpdateRun }>(base, 'POST', '/v1/update', { version: parsed.data.version });
    if (!res.ok && res.restarting) throw new ApiError(409, UPDATER_RESTARTING_TITLE, res.error);
    if (!res.ok) throw new ApiError(res.status === 409 || res.status === 400 ? res.status : 502, res.status === 409 ? 'Conflict' : 'Bad Gateway', res.error);
    request.log.info({ event: 'update.started', userId: user.id, version: parsed.data.version, runId: res.body.run.id }, 'in-app update started');
    return reply.status(202).send(res.body);
  });
}

let verifier: SignatureVerifier | null = null;

/** Registered outside the signed-in routes: the updater signs instead of holding a session. */
export async function createUpdaterInternalRoutes(fastify: FastifyInstance) {
  fastify.get('/internal/updater/versions', { logLevel: 'warn' }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!updaterUrl()) throw new ApiError(404, 'Not Found', 'The updater is not installed on this server');
    verifier ??= new SignatureVerifier(appSecret());
    const header = (n: string) => {
      const v = request.headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    const auth = verifier.verify({ method: 'GET', path: request.url, body: '', time: header(TIME_HEADER), signature: header(SIGNATURE_HEADER) });
    if (!auth.ok) throw new ApiError(401, 'Unauthorized', auth.reason);
    const workers = await liveWorkers();
    return reply.send({
      app: readBuildInfo().version,
      workers: workers.map((w) => ({ workerId: w.workerId, version: w.version, lastSeenAt: w.lastSeenAt })),
    });
  });
}
