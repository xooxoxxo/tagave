/**
 * Facets and the Music Connections module (Facets and Connectors design §4,
 * §8; decision D5).
 *
 *   GET  /api/v1/facets                                 which facets are available, which modules are on (the app hides what is off)
 *   GET  /api/v1/settings/music-connections             the Settings › Modules row: on or off, what it holds
 *   PUT  /api/v1/settings/music-connections             owner + fresh step-up, { enabled }: turn it on or off (the data stays)
 *   POST /api/v1/settings/music-connections/remove-data owner + fresh step-up, { keepFills? }: revoke every link (at the remote too), delete its data, turn it off
 *
 * Off: connections.pull skips, the Connections page, the wantlist
 * suggestions and the linked apps' critic scores hide, this tagave's
 * manifest and feeds answer 404, and every row stays. Remove data deletes
 * exactly the module's rows and reverts the album MBIDs it filled, unless
 * "Keep" is ticked (then they are confirmed and stay).
 */
import type { FastifyInstance } from 'fastify';
import { registry } from '@tagave/core/facets';
import { openTokens, revokeAtRemote } from '@tagave/core/mc';
import { mcEnabled, removeMcData, setMcEnabled } from '@tagave/db';
import { mcModuleSchema, mcRemoveDataSchema, type FacetsView, type McModuleView } from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { facetContext } from '../lib/facets.js';
import { requireFreshStepUp } from './stepUp.js';
import { sameSite } from './mcConnections.js';

async function moduleView(): Promise<McModuleView> {
  const { sql } = getAuthHandle();
  const [c] = await sql<Array<{ links: number; landed: number; fills: number }>>`
    select (select count(*)::int from mc_links where state <> 'revoked') as links,
           ((select count(*) from mc_critic_scores) + (select count(*) from mc_identity) + (select count(*) from mc_wantlist_suggestions))::int as landed,
           (select count(*)::int from identity_fills where module = 'mc' and confirmed_at is null) as fills`;
  return { enabled: await mcEnabled(sql), links: c!.links, landed: c!.landed, fills: c!.fills };
}

export async function createFacetRoutes(fastify: FastifyInstance) {
  fastify.get('/facets', async (request): Promise<FacetsView> => {
    const { sql } = getAuthHandle();
    const ctx = await facetContext(sql, { userId: request.user?.id ?? null, libraryId: null });
    return registry.state(ctx);
  });

  fastify.get('/settings/music-connections', async (): Promise<McModuleView> => moduleView());

  fastify.put('/settings/music-connections', async (request): Promise<McModuleView> => {
    sameSite(request);
    const parsed = mcModuleSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'enabled (true or false) is required');
    await requireFreshStepUp(request);
    const { sql } = getAuthHandle();
    if (parsed.data.enabled) {
      const can = registry.canTurnOn('mc', { settings: { mcEnabled: true }, playerUrl: process.env['TAGAVE_PLAYER_URL'] || null });
      if (!can.ok) throw new ApiError(409, 'Conflict', `Music Connections cannot be turned on: ${can.reason}.`);
    }
    await setMcEnabled(sql, parsed.data.enabled);
    request.log.info({ event: parsed.data.enabled ? 'module.enable' : 'module.disable', module: 'mc', userId: request.user?.id }, 'music connections switched');
    return moduleView();
  });

  fastify.post('/settings/music-connections/remove-data', async (request): Promise<McModuleView & { removed: { links: number; rows: number; fillsReverted: number } }> => {
    sameSite(request);
    const parsed = mcRemoveDataSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'keepFills must be true or false');
    await requireFreshStepUp(request);
    const { sql, env } = getAuthHandle();
    // off first: no pull starts while the data goes
    await setMcEnabled(sql, false);
    // every link's tokens back to their issuer (best effort), then the rows
    const links = await sql<Array<{ remote_url: string; manifest: unknown; client_id: string; sealed_tokens: string }>>`
      select remote_url, manifest, client_id, sealed_tokens from mc_links where sealed_tokens <> ''`;
    for (const l of links) {
      const tokens = openTokens(l.sealed_tokens, env.appSecret);
      if (tokens) await revokeAtRemote({ remoteUrl: l.remote_url, manifest: l.manifest, clientId: l.client_id }, tokens);
    }
    const removed = await removeMcData(sql, { keepFills: parsed.data.keepFills === true, actorUserId: request.user?.id ?? null });
    await sql`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
              values (null, ${request.user?.id ?? null}, 'module.remove_data', 'module',
                      ${JSON.stringify({ module: 'mc', keep_fills: parsed.data.keepFills === true, ...removed })}::text::jsonb)`;
    request.log.info({ event: 'module.remove_data', module: 'mc', userId: request.user?.id, ...removed }, 'music connections data removed');
    return { ...(await moduleView()), removed: { links: removed.links, rows: removed.rows, fillsReverted: removed.fillsReverted } };
  });
}
