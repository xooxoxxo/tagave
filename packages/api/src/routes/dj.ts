/**
 * DJ, the dj module (vault "tagave - DJ Module").
 *
 *   GET  /api/v1/me/dj/tracks?ids=a,b,c          player.use: DjTrackInfo[] (≤ 50 ids), queues the missing analyses
 *   GET  /api/v1/me/dj/peaks/:localTrackId       player.use: { peaks } 0–1, ~900 bins (empty until measured)
 *   POST /api/v1/me/dj/analyze                   player.use: { localTrackIds } measure these next (the queue's next tracks)
 *   GET  /api/v1/settings/dj                     system.manage: Settings › Modules › DJ
 *   PUT  /api/v1/settings/dj                     system.manage + fresh step-up: { enabled }
 *   POST /api/v1/settings/dj/remove-data         system.manage + fresh step-up: turn it off, delete its rows
 *
 * Off: every /me/dj route answers 404, nothing is queued. A track's
 * analysis is served while its row has no error, even when its file changed
 * since (a re-tag keeps it; dj.analyze checks and replaces it if the audio
 * changed). What the player asks for runs ahead of the sweep (priority 10).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { djEnabled, moduleSettings, removeDjData, setDjEnabled, DJ_MODULE_ID } from '@tagave/db';
import { peaksToUnit } from '@tagave/core/dj';
import {
  DJ_TRACKS_MAX, djAnalyzeSchema, djModuleSchema,
  type DjAnalyzeResult, type DjModuleView, type DjPeaks, type DjTrackInfo,
} from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { getBoss } from '../boss.js';
import { requireFreshStepUp } from './stepUp.js';
import { sameSite } from './mcConnections.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** pg-boss priorities (worker › jobs/djAnalyze.ts DJ_PRIORITY): the player's asks first. */
const ASKED_PRIORITY = 10;
const SWEEP_PRIORITY = 0;

type Sql = ReturnType<typeof getAuthHandle>['sql'];

function user(request: FastifyRequest): { id: string } {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  return request.user;
}

async function requireOn(sql: Sql): Promise<void> {
  if (!(await djEnabled(sql))) throw new ApiError(404, 'Not Found', 'DJ is turned off');
}

/**
 * A row in need of dj.analyze: none, its file changed since, or a failure
 * a week old (the sweep's rule, worker › jobs/djAnalyze.ts).
 */
const NEEDS_ANALYSIS = `(d.local_track_id is null
  or d.file_size_bytes is distinct from f.size_bytes
  or d.file_mtime is distinct from f.mtime
  or (d.error is not null and d.analyzed_at < now() - interval '7 days'))`;

/** Queue the player's asks; never fails the request. */
async function queueAsked(request: FastifyRequest, ids: readonly string[]): Promise<number> {
  if (!ids.length) return 0;
  try {
    const boss = await getBoss();
    let queued = 0;
    for (const id of ids) {
      // its own key: a track the sweep queued at its low priority still jumps ahead
      if (await boss.send('dj.analyze', { localTrackId: id }, { singletonKey: `dj:now:${id}`, priority: ASKED_PRIORITY, retryLimit: 1 })) queued++;
    }
    return queued;
  } catch (err) {
    request.log.warn({ err, count: ids.length }, 'dj.analyze not queued');
    return 0;
  }
}

async function queueSweep(request: FastifyRequest): Promise<void> {
  try {
    const boss = await getBoss();
    await boss.send('dj.analyze', { sweep: true }, { singletonKey: 'dj:sweep', priority: SWEEP_PRIORITY, retryLimit: 1 });
  } catch (err) {
    request.log.warn({ err }, 'dj sweep not queued');
  }
}

function parseIds(raw: unknown): string[] {
  const text = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : '';
  const ids = [...new Set(text.split(',').map((s) => s.trim()).filter(Boolean))];
  if (!ids.length) throw new ApiError(400, 'Bad Request', 'ids (comma-separated track ids) is required');
  if (ids.length > DJ_TRACKS_MAX) throw new ApiError(400, 'Bad Request', `At most ${DJ_TRACKS_MAX} ids`);
  if (ids.some((id) => !UUID_RE.test(id))) throw new ApiError(400, 'Bad Request', 'ids must be track ids');
  return ids.map((id) => id.toLowerCase());
}

interface TrackRow {
  id: string;
  album: string | null;
  track_no: number | null;
  disc_no: number | null;
  duration_ms: number | null;
  ok: boolean;
  bpm: string | null;
  bpm_confidence: number | null;
  first_beat_ms: number | null;
  trim_start_ms: number | null;
  trim_end_ms: number | null;
  needs: boolean;
}

async function moduleView(sql: Sql): Promise<DjModuleView> {
  const [c] = await sql<Array<{ analyzed: number; tracks: number }>>`
    select (select count(*)::int from dj_track_analysis where error is null) as analyzed,
           (select count(*)::int from local_tracks) as tracks`;
  return { enabled: await djEnabled(sql), analyzed: c!.analyzed, tracks: c!.tracks, settings: await moduleSettings(sql, DJ_MODULE_ID) };
}

export async function createDjRoutes(fastify: FastifyInstance) {
  fastify.get('/me/dj/tracks', async (request): Promise<DjTrackInfo[]> => {
    user(request);
    const ids = parseIds((request.query as { ids?: unknown } | undefined)?.ids);
    const { sql } = getAuthHandle();
    await requireOn(sql);
    const rows = await sql<TrackRow[]>`
      select lt.id::text as id, lt.local_album_id::text as album, lt.track_no, lt.disc_no,
             coalesce(lt.duration_ms, f.duration_ms, d.duration_ms) as duration_ms,
             (d.local_track_id is not null and d.error is null) as ok,
             d.bpm::text as bpm, d.bpm_confidence, d.first_beat_ms, d.trim_start_ms, d.trim_end_ms,
             (f.status = 'present' and ${sql.unsafe(NEEDS_ANALYSIS)}) as needs
        from local_tracks lt
        join files f on f.id = lt.audio_file_id
        left join dj_track_analysis d on d.local_track_id = lt.id
       where lt.id = any(${ids}::uuid[])`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    await queueAsked(request, rows.filter((r) => r.needs).map((r) => r.id));
    return ids.flatMap((id): DjTrackInfo[] => {
      const r = byId.get(id);
      if (!r) return [];
      return [{
        localTrackId: r.id,
        bpm: r.ok && r.bpm != null ? Number(r.bpm) : null,
        bpmConfidence: r.ok ? r.bpm_confidence : null,
        firstBeatMs: r.ok ? r.first_beat_ms : null,
        trimStartMs: r.ok ? r.trim_start_ms : null,
        trimEndMs: r.ok ? r.trim_end_ms : null,
        durationMs: r.duration_ms ?? 0,
        albumKey: r.album,
        trackNo: r.track_no,
        discNo: r.disc_no,
      }];
    });
  });

  fastify.get('/me/dj/peaks/:localTrackId', async (request): Promise<DjPeaks> => {
    user(request);
    const { localTrackId } = request.params as { localTrackId: string };
    const { sql } = getAuthHandle();
    await requireOn(sql);
    if (!UUID_RE.test(localTrackId)) throw new ApiError(404, 'Not Found', 'Track not found');
    const [r] = await sql<Array<{ peaks: Buffer | null; ok: boolean; needs: boolean }>>`
      select d.peaks, (d.local_track_id is not null and d.error is null) as ok,
             (f.status = 'present' and ${sql.unsafe(NEEDS_ANALYSIS)}) as needs
        from local_tracks lt
        join files f on f.id = lt.audio_file_id
        left join dj_track_analysis d on d.local_track_id = lt.id
       where lt.id = ${localTrackId}`;
    if (!r) throw new ApiError(404, 'Not Found', 'Track not found');
    if (r.needs) await queueAsked(request, [localTrackId]);
    return { peaks: r.ok && r.peaks ? peaksToUnit(new Uint8Array(r.peaks)) : [] };
  });

  fastify.post('/me/dj/analyze', async (request): Promise<DjAnalyzeResult> => {
    user(request);
    sameSite(request);
    const parsed = djAnalyzeSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', `localTrackIds (1 to ${DJ_TRACKS_MAX} track ids) is required`);
    const { sql } = getAuthHandle();
    await requireOn(sql);
    const ids = [...new Set(parsed.data.localTrackIds.map((id) => id.toLowerCase()))];
    const rows = await sql<Array<{ id: string }>>`
      select lt.id::text as id
        from local_tracks lt
        join files f on f.id = lt.audio_file_id and f.status = 'present'
        left join dj_track_analysis d on d.local_track_id = lt.id
       where lt.id = any(${ids}::uuid[]) and ${sql.unsafe(NEEDS_ANALYSIS)}`;
    // in the order asked: the next track first
    const need = new Set(rows.map((r) => r.id));
    return { queued: await queueAsked(request, ids.filter((id) => need.has(id))) };
  });

  fastify.get('/settings/dj', async (): Promise<DjModuleView> => moduleView(getAuthHandle().sql));

  fastify.put('/settings/dj', async (request): Promise<DjModuleView> => {
    sameSite(request);
    const parsed = djModuleSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'enabled (true or false) is required');
    await requireFreshStepUp(request);
    const { sql } = getAuthHandle();
    await setDjEnabled(sql, parsed.data.enabled);
    request.log.info({ event: parsed.data.enabled ? 'module.enable' : 'module.disable', module: DJ_MODULE_ID, userId: request.user?.id }, 'dj switched');
    // on: the sweep starts now, not at the next hour
    if (parsed.data.enabled) await queueSweep(request);
    return moduleView(sql);
  });

  fastify.post('/settings/dj/remove-data', async (request): Promise<DjModuleView & { removed: Record<string, number> }> => {
    sameSite(request);
    await requireFreshStepUp(request);
    const { sql } = getAuthHandle();
    // off first: no analysis starts while the rows go
    await setDjEnabled(sql, false);
    const removed = await removeDjData(sql);
    await sql`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
              values (null, ${request.user?.id ?? null}, 'module.remove_data', 'module', ${JSON.stringify({ module: DJ_MODULE_ID, ...removed })}::text::jsonb)`;
    request.log.info({ event: 'module.remove_data', module: DJ_MODULE_ID, userId: request.user?.id, ...removed }, 'dj data removed');
    return { ...(await moduleView(sql)), removed };
  });
}
