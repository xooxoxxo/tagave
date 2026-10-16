/**
 * Settings › Modules (owner only): the optional parts of tagave from the
 * signed catalogue of the release that runs here.
 *
 *   GET  /api/v1/modules                  the catalogue, each module's state and the current or last run
 *   POST /api/v1/modules/:id/enable       owner + fresh step-up: turn it on (202)
 *   POST /api/v1/modules/:id/disable      owner + fresh step-up, { deleteData }: turn it off (202)
 *
 * With the updater, the updater does the work and checks the release's
 * signature itself; the app brings it the signed manifest of the running
 * release when it does not have it yet. Without the updater the page lists
 * the same catalogue (checked here with the same keys) and shows the
 * install-tagave.sh command for each module.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readBuildInfo } from '@tagave/core';
import {
  MODULE_ID_RE, moduleActionSchema, type ModuleRun, type ModuleStatus, type ModulesView, type UpdaterModules,
} from '@tagave/shared';
import { ReleaseRefused, verifyRelease } from '@tagave/updater/release';
import { ApiError } from '../middleware/errorHandler.js';
import { appReleaseKeys, fetchReleaseFiles } from '../lib/releaseFiles.js';
import { RELEASE_REFUSED_TITLE, UPDATER_RESTARTING_TITLE, callUpdater, requireOwner, updaterUrl } from './updater.js';
import { requireFreshStepUp } from './stepUp.js';

// Owner only: requireOwner below. With the permission layer these are
// 'GET /api/v1/modules' and 'POST /api/v1/modules/:id/:action' → system.manage.

/** The updater has no manifest yet: fetch the running release's and hand it over. Null when it has one or took this one. */
async function bringRelease(base: string, view: UpdaterModules): Promise<UpdaterModules | string> {
  if (view.verified || !view.version) return view;
  let files: { manifest: string; signature: string };
  try {
    files = await fetchReleaseFiles(view.version);
  } catch (err) {
    return `${view.problem ?? 'no signed manifest here'}; downloading it failed: ${(err as Error).message}`;
  }
  const res = await callUpdater<UpdaterModules>(base, 'POST', '/v1/release', files);
  return res.ok ? res.body : res.error;
}

/** Without the updater: the catalogue of the running release, checked with the keys in the app image. */
async function commandView(): Promise<ModulesView> {
  const version = readBuildInfo().version;
  const role = process.env['TAGAVE_ROLE'] || null;
  const base: ModulesView = { mode: 'command', error: null, version, verified: false, problem: null, modules: [], run: null, role };
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) return { ...base, problem: `this server runs ${version || 'a development build'}, which has no signed release manifest` };
  try {
    const files = await fetchReleaseFiles(version);
    const { manifest } = verifyRelease(files.manifest, files.signature, await appReleaseKeys(), { version });
    const playerOn = !!process.env['TAGAVE_PLAYER_URL'];
    const modules: ModuleStatus[] = manifest.modules.map((m) => {
      const splitReason = role === 'files' ? 'This computer runs only the file worker.' : role && !m.roles.includes(role as 'all' | 'app') ? `${m.name} needs everything on one computer; this is the app computer of a split install.` : null;
      return {
        id: m.id,
        name: m.name,
        purpose: m.purpose,
        // The app cannot read COMPOSE_PROFILES; the player shows through TAGAVE_PLAYER_URL.
        state: m.id === 'player' && playerOn ? 'on' : 'off',
        estimate: m.estimate,
        keepsOnRemoval: m.keepsOnRemoval,
        roles: m.roles,
        downloadBytes: null,
        available: splitReason === null,
        reason: splitReason,
        lastError: null,
      };
    });
    return { ...base, verified: true, modules };
  } catch (err) {
    return { ...base, problem: err instanceof ReleaseRefused ? err.message : (err as Error).message };
  }
}

export async function createModuleRoutes(fastify: FastifyInstance) {
  fastify.get('/modules', async (request: FastifyRequest, reply: FastifyReply) => {
    requireOwner(request);
    const base = updaterUrl();
    if (!base) return reply.send(await commandView());
    const res = await callUpdater<UpdaterModules>(base, 'GET', '/v1/modules');
    if (!res.ok) {
      const error = res.status === 404 ? 'the updater here is older than modules; update tagave first' : res.error;
      return reply.send({ mode: 'unreachable', error, version: null, verified: false, problem: null, modules: [], run: null, role: process.env['TAGAVE_ROLE'] || null } satisfies ModulesView);
    }
    const view = await bringRelease(base, res.body);
    const v = typeof view === 'string' ? { ...res.body, problem: view } : view;
    return reply.send({ mode: 'updater', error: null, version: v.version, verified: v.verified, problem: v.problem, modules: v.modules, run: v.run, role: process.env['TAGAVE_ROLE'] || null } satisfies ModulesView);
  });

  fastify.post<{ Params: { id: string; action: string } }>('/modules/:id/:action', async (request, reply) => {
    const user = requireOwner(request);
    const { id, action } = request.params;
    if (!MODULE_ID_RE.test(id) || (action !== 'enable' && action !== 'disable')) throw new ApiError(404, 'Not Found', 'No such module action');
    const parsed = moduleActionSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'Invalid body');
    const base = updaterUrl();
    if (!base) throw new ApiError(409, 'Conflict', `The updater is not installed on this server; run ./install-tagave.sh ${action}-module ${id} in the install folder`);
    await requireFreshStepUp(request);
    const status = await callUpdater<UpdaterModules>(base, 'GET', '/v1/modules');
    if (status.ok && !status.body.verified) {
      const brought = await bringRelease(base, status.body);
      if (typeof brought === 'string') throw new ApiError(422, RELEASE_REFUSED_TITLE, `${brought}. Nothing was changed.`);
    }
    const res = await callUpdater<{ run: ModuleRun }>(base, 'POST', `/v1/modules/${id}/${action}`, { deleteData: parsed.data.deleteData === true });
    if (!res.ok && res.restarting) throw new ApiError(409, UPDATER_RESTARTING_TITLE, res.error);
    if (!res.ok) {
      const map: Record<number, [number, string]> = { 409: [409, 'Conflict'], 404: [404, 'Not Found'], 422: [422, RELEASE_REFUSED_TITLE], 400: [400, 'Bad Request'] };
      const [code, title] = map[res.status] ?? [502, 'Bad Gateway'];
      throw new ApiError(code, title, res.error);
    }
    request.log.info({ event: `module.${action}`, userId: user.id, module: id, runId: res.body.run.id, deleteData: parsed.data.deleteData === true }, `module ${action} started`);
    return reply.status(202).send(res.body);
  });
}
