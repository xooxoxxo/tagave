/**
 * Wantlist suggestions from linked apps (Music Connections spec §3
 * wantlist-suggestions; design §10 4.6), each person their own:
 *
 *   GET  /api/v1/me/wantlist                                  the suggestions (undecided first) and the wantlist entries kept in tagave
 *   POST /api/v1/me/wantlist-suggestions/:id/decision         { decision: accepted | dismissed }
 *
 * A decision goes to the app that made the suggestion first:
 * POST <its wantlist-suggestions feed>/<key>/decision, through the pinned,
 * origin-checked transport with the link's token (lib/mcRemoteCall.ts). Only
 * when it answers 2xx is the decision kept here; Accept then adds a
 * tagave-only wantlist entry through the wantlist's own command (wantlist.add,
 * @tagave/db › wantlist.ts) in the caller's library. A 403 or 404 from the app is said in the
 * answer, for the panel to show.
 *
 * The suggestion's text (reason) is the remote's: kept length-capped and
 * shown as text, never as HTML.
 */
import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { WANTLIST_WRITE } from '@tagave/core/mc';
import { wantlistDecisionSchema, type WantlistEntryView, type WantlistSuggestionView, type WantlistView } from '@tagave/shared';
import { mcEnabled, wantlistAdd } from '@tagave/db';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { postToLinkedApp, type RemoteLink } from '../lib/mcRemoteCall.js';
import { sameSite } from './mcConnections.js';

type Sql = postgres.Sql;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jsonOf = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

interface SuggestionRow {
  id: string; link_id: string; key: string; service: string | null; release_group_id: string | null;
  album: unknown; data: unknown; decision: 'accepted' | 'dismissed' | null; decided_at: Date | null;
}

function suggestionView(r: SuggestionRow): WantlistSuggestionView {
  const album = jsonOf<{ rg_mbid: string | null; artist: string; title: string }>(r.album);
  const data = jsonOf<{ reason: string; score: number | null; suggested_at: string }>(r.data);
  return {
    id: r.id,
    linkId: r.link_id,
    service: r.service || 'a linked app',
    artist: album.artist,
    title: album.title,
    releaseGroupId: r.release_group_id,
    rgMbid: album.rg_mbid,
    reason: data.reason,
    score: data.score,
    suggestedAt: data.suggested_at,
    decision: r.decision,
    decidedAt: iso(r.decided_at),
  };
}

const UUID = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

/** The caller's library: it must exist (every account reads every library, 0043; collection.ts › ownLibrary). */
async function callerLibrary(sql: Sql, libraryId: unknown): Promise<string> {
  if (!UUID(libraryId)) throw new ApiError(400, 'Bad Request', 'libraryId is required');
  const [l] = await sql<Array<{ id: string }>>`select id::text as id from libraries where id = ${libraryId}`;
  if (!l) throw new ApiError(404, 'Not Found', 'Library not found');
  return l.id;
}

/** What the panel says when the linked app does not take the decision. */
export function decisionProblem(service: string, r: { status: number | null; reason: string }): ApiError {
  if (r.reason === 'needs_reapproval') return new ApiError(409, 'Conflict', `${service} needs this connection approved again before it takes decisions. Re-approve it in Settings › Connections.`);
  if (r.status === 403) return new ApiError(502, 'Bad Gateway', `${service} refused the decision (403): this connection may not send decisions. Re-approve it in Settings › Connections to grant that.`);
  if (r.status === 404) return new ApiError(502, 'Bad Gateway', `${service} no longer has this suggestion (404). It will drop off at the next sync.`);
  if (r.status !== null) return new ApiError(502, 'Bad Gateway', `${service} did not take the decision (HTTP ${r.status}). Nothing was changed; try again later.`);
  return new ApiError(502, 'Bad Gateway', `Could not reach ${service}. Nothing was changed; try again later.`);
}

export async function createMcWantlistRoutes(fastify: FastifyInstance) {
  fastify.get('/me/wantlist', async (request): Promise<WantlistView> => {
    const user = request.user!;
    const { sql } = getAuthHandle();
    const libraryId = await callerLibrary(sql, (request.query as { libraryId?: unknown }).libraryId);
    const available = await mcEnabled(sql);
    const rows = available ? await sql<SuggestionRow[]>`
      select s.id::text as id, s.link_id::text as link_id, s.key, l.manifest->>'service' as service, s.release_group_id::text as release_group_id,
             s.album, s.data, s.decision, s.decided_at
        from mc_wantlist_suggestions s join mc_links l on l.id = s.link_id
       where s.user_id = ${user.id} and l.state <> 'revoked'
       order by (s.decision is null) desc, s.decided_at desc nulls last, s.remote_updated_at desc, s.id
       limit 200` : [];
    const entries = await sql<Array<{ id: string; artist: string | null; title: string | null; rg: string | null; rg_title: string | null; rg_mbid: string | null; discogs: number | null; date_added: Date | null }>>`
      select w.id::text as id, w.artist, w.title, w.release_group_id::text as rg, g.title as rg_title, coalesce(g.mbid, w.release_group_mbid) as rg_mbid,
             w.discogs_release_id as discogs, w.date_added
        from wantlist_items w join collection_sources cs on cs.id = w.collection_source_id
        left join release_groups g on g.id = w.release_group_id
       where cs.provider = 'tagave' and w.library_id = ${libraryId} and w.removed_at is null
       order by w.date_added desc nulls last, w.id
       limit 500`;
    const wantlist: WantlistEntryView[] = entries.map((e) => ({
      id: e.id, artist: e.artist, title: e.title ?? e.rg_title, releaseGroupId: e.rg, releaseGroupMbid: e.rg_mbid, discogsReleaseId: e.discogs, dateAdded: iso(e.date_added),
    }));
    return { available, suggestions: rows.map(suggestionView), wantlist };
  });

  fastify.post('/me/wantlist-suggestions/:id/decision', async (request): Promise<WantlistSuggestionView> => {
    const user = request.user!;
    sameSite(request);
    const { sql, env } = getAuthHandle();
    if (!(await mcEnabled(sql))) throw new ApiError(409, 'Conflict', 'Music Connections is turned off.');
    const id = (request.params as { id: string }).id;
    if (!UUID_RE.test(id)) throw new ApiError(404, 'Not Found', 'No such suggestion.');
    const parsed = wantlistDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'decision (accepted or dismissed) and libraryId are required');
    const decision = parsed.data.decision;
    const libraryId = await callerLibrary(sql, parsed.data.libraryId);
    const [row] = await sql<Array<SuggestionRow & { scopes: string[] } & RemoteLink>>`
      select s.id::text as id, s.link_id::text as link_id, s.key, l.manifest->>'service' as service, s.release_group_id::text as release_group_id,
             s.album, s.data, s.decision, s.decided_at,
             l.remote_url, l.manifest, l.client_id, l.sealed_tokens, l.state, l.scopes
        from mc_wantlist_suggestions s join mc_links l on l.id = s.link_id
       where s.id = ${id} and s.user_id = ${user.id}`;
    if (!row) throw new ApiError(404, 'Not Found', 'No such suggestion.');
    const service = row.service || 'The linked app';
    if (row.decision) throw new ApiError(409, 'Conflict', `Already ${row.decision}.`);
    if (!row.scopes.includes(WANTLIST_WRITE)) {
      throw new ApiError(403, 'Forbidden', `This connection was not granted permission to send decisions to ${service}. Re-approve it in Settings › Connections.`);
    }
    // the remote first: only a decision it took is kept here
    const r = await postToLinkedApp(sql, { ...row, id: row.link_id }, 'wantlist-suggestions', `${encodeURIComponent(row.key)}/decision`, { decision }, env.appSecret);
    if (!r.ok) {
      request.log.info({ event: 'mc.wantlist.decision_refused', userId: user.id, linkId: row.link_id, status: r.status, reason: r.reason }, 'wantlist decision not taken');
      throw decisionProblem(service, r);
    }
    const updated = await sql.begin(async (tx) => {
      let itemId: string | null = null;
      if (decision === 'accepted') {
        // the wantlist's own command adds the entry (the wantlist module owns wantlist_items)
        const album = jsonOf<{ rg_mbid: string | null; discogs_release_id?: number; artist: string; title: string }>(row.album);
        itemId = await wantlistAdd(tx, {
          libraryId,
          releaseGroupId: row.release_group_id,
          releaseGroupMbid: album.rg_mbid,
          discogsReleaseId: album.discogs_release_id ?? null,
          title: album.title,
          artist: album.artist,
          origin: `mc:${row.link_id}`,
        });
      }
      const [u] = await tx<SuggestionRow[]>`
        update mc_wantlist_suggestions set decision = ${decision}, decided_at = now(), wantlist_item_id = ${itemId}
         where id = ${id} and decision is null
        returning id::text as id, link_id::text as link_id, key, ${row.service} as service, release_group_id::text as release_group_id, album, data, decision, decided_at`;
      return u;
    });
    if (!updated) throw new ApiError(409, 'Conflict', 'Already decided.');
    request.log.info({ event: 'mc.wantlist.decision', userId: user.id, linkId: row.link_id, decision }, 'wantlist suggestion decided');
    return suggestionView(updated);
  });
}
