/**
 * Identify pipeline triage + coverage metrics (XO-309, spec §10.3 / §14.2).
 *
 *   GET  /libraries/:lib/identify/stats   coverage, G1 target, rate, ETA, series
 *   GET  /libraries/:lib/identify/triage  unidentified albums by reason (+ failed jobs)
 *   POST /libraries/:lib/identify/retry   re-run identification for a selection
 *   POST /libraries/:lib/identify/sweep   kick the sweep top-up now
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, sql, desc } from 'drizzle-orm';
import { libraries, jobRuns } from '@liner/db';
import { getDb } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';
import { IDENTIFY_PRIORITY, IDENTIFY_SINGLETON, listPendingIdentifyRequests, pendingIdentifyJob, cancelIdentifyJob } from '../lib/identifyRequests.js';

/** G1 (spec §2): 95% of albums identified by day 30 of the library's life. */
const G1_SHARE = 0.95;
const G1_DAYS = 30;

export const IDENTIFY_REASONS = ['no_tags', 'no_candidates', 'weak_candidates', 'ambiguous', 'provider_errors', 'job_failed'] as const;
export type IdentifyReason = (typeof IDENTIFY_REASONS)[number];

const RETRY_CAP = 500;

/** A failed identify job is history once a fresh job is waiting for the same
 * album (the sweep re-enqueues pending albums); only orphaned failures count. */
const NO_LIVE_JOB = sql`not exists (
  select 1 from pgboss.job q
   where q.name = 'identify.album' and q.state in ('created', 'retry', 'active')
     and q.data->>'localAlbumId' = j.data->>'localAlbumId')`;

async function ownedLibrary(userId: string, libraryId: string) {
  const db = getDb();
  const rows = await db.select().from(libraries)
    .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, userId)));
  const lib = rows[0];
  if (!lib) throw new ApiError(404, 'Not Found', 'Library not found');
  return lib;
}

export async function createIdentifyRoutes(fastify: FastifyInstance) {
  fastify.get('/libraries/:libraryId/identify/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const lib = await ownedLibrary(request.user.id, libraryId);
    const db = getDb();

    const [c] = await db.execute(sql`
      select count(*)::int as total,
             count(*) filter (where state = 'matched')::int as matched,
             count(*) filter (where state = 'needs_review')::int as needs_review,
             count(*) filter (where state = 'pending')::int as pending,
             count(*) filter (where state = 'unidentified')::int as unidentified,
             count(*) filter (where state <> 'pending' and last_identify_at > now() - interval '15 min')::int as decided_15m,
             count(*) filter (where state <> 'pending' and last_identify_at > now() - interval '60 min')::int as decided_60m,
             count(*) filter (where state = 'matched' and identified_at > now() - interval '24 hours')::int as matched_24h,
             count(*) filter (where state = 'matched' and (identified_at is null or identified_at < date_trunc('day', now()) - interval '29 days'))::int as matched_before_window
        from local_albums where library_id = ${libraryId}`) as unknown as [Record<string, number>];

    const reasonRows = await db.execute(sql`
      select coalesce(identify_reason, 'unknown') as reason, count(*)::int as n
        from local_albums
       where library_id = ${libraryId} and state in ('unidentified', 'needs_review')
       group by 1`) as unknown as Array<{ reason: string; n: number }>;

    const queueRows = await db.execute(sql`
      select state, count(*)::int as n from pgboss.job
       where name = 'identify.album' group by 1`) as unknown as Array<{ state: string; n: number }>;
    const failedAlbumRows = await db.execute(sql`
      select count(distinct data->>'localAlbumId')::int as n from pgboss.job j
       where j.name = 'identify.album' and j.state = 'failed' and ${NO_LIVE_JOB}
         and exists (select 1 from local_albums la where la.id = (j.data->>'localAlbumId')::uuid
                       and la.library_id = ${libraryId} and la.state = 'pending')`) as unknown as [{ n: number }];

    const seriesRows = await db.execute(sql`
      select to_char(date_trunc('day', identified_at), 'YYYY-MM-DD') as day, count(*)::int as n
        from local_albums
       where library_id = ${libraryId} and state = 'matched'
         and identified_at >= date_trunc('day', now()) - interval '29 days'
       group by 1 order by 1`) as unknown as Array<{ day: string; n: number }>;

    const sweepRows = await db.select().from(jobRuns)
      .where(and(eq(jobRuns.libraryId, libraryId), eq(jobRuns.type, 'identify.sweep')))
      .orderBy(desc(jobRuns.createdAt)).limit(1);
    const sweep = sweepRows[0];

    // Provenance (XO-309 fast-path metrics): where the live matches came from,
    // and how the albums whose tags name a MusicBrainz release fared.
    const sourceRows = await db.execute(sql`
      select coalesce(source, 'unknown') as source, count(*)::int as n
        from album_matches
       where library_id = ${libraryId} and status in ('auto', 'confirmed')
       group by 1`) as unknown as Array<{ source: string; n: number }>;
    const [fp] = await db.execute(sql`
      select count(*)::int as eligible,
             count(*) filter (where la.state = 'matched' and m.source = 'mbid')::int as via_mbid,
             count(*) filter (where la.state = 'matched' and (m.source is null or m.source <> 'mbid'))::int as via_other,
             count(*) filter (where la.state in ('unidentified', 'needs_review'))::int as undecided,
             count(*) filter (where la.state = 'pending')::int as pending
        from local_albums la
        left join lateral (
          select am.source from album_matches am
           where am.local_album_id = la.id and am.status in ('auto', 'confirmed') limit 1) m on true
       where la.library_id = ${libraryId} and la.embedded_mbid is not null`) as unknown as [Record<string, number>];
    const sources: Record<string, number> = {};
    for (const r of sourceRows) sources[r.source] = r.n;

    const total = c?.['total'] ?? 0;
    const matched = c?.['matched'] ?? 0;
    const pending = c?.['pending'] ?? 0;
    const perMin15 = (c?.['decided_15m'] ?? 0) / 15;
    const perHour = c?.['decided_60m'] ?? 0;
    const queue: Record<string, number> = { created: 0, active: 0, retry: 0, failed: 0, completed: 0 };
    for (const q of queueRows) queue[q.state] = q.n;
    const reasons: Record<string, number> = {};
    for (const r of reasonRows) reasons[r.reason] = r.n;
    reasons['job_failed'] = failedAlbumRows[0]?.n ?? 0;

    // G1 clock starts when the library was created.
    const createdAt = lib.createdAt instanceof Date ? lib.createdAt : new Date(lib.createdAt as unknown as string);
    const dayMs = 86_400_000;
    const day = Math.max(1, Math.floor((Date.now() - createdAt.getTime()) / dayMs) + 1);
    const deadline = new Date(createdAt.getTime() + G1_DAYS * dayMs);
    const daysLeft = Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / dayMs));
    const needed = Math.max(0, Math.ceil(total * G1_SHARE) - matched);
    const requiredPerDay = daysLeft > 0 ? Math.ceil(needed / daysLeft) : needed;
    const matched24h = c?.['matched_24h'] ?? 0;

    // 30-day series with cumulative identified share per day.
    const byDay = new Map(seriesRows.map((r) => [r.day, r.n]));
    let cumulative = c?.['matched_before_window'] ?? 0;
    const series: Array<{ day: string; matched: number; cumulativeShare: number }> = [];
    const start = new Date(Date.now() - 29 * dayMs);
    for (let i = 0; i < 30; i++) {
      const d = new Date(start.getTime() + i * dayMs).toISOString().slice(0, 10);
      const n = byDay.get(d) ?? 0;
      cumulative += n;
      series.push({ day: d, matched: n, cumulativeShare: total ? cumulative / total : 0 });
    }

    reply.send({
      total,
      states: {
        matched,
        needsReview: c?.['needs_review'] ?? 0,
        pending,
        unidentified: c?.['unidentified'] ?? 0,
      },
      identifiedShare: total ? matched / total : 0,
      target: {
        share: G1_SHARE,
        day,
        days: G1_DAYS,
        deadline: deadline.toISOString(),
        daysLeft,
        needed,
        requiredPerDay,
        matched24h,
        onTrack: needed === 0 || matched24h >= requiredPerDay,
      },
      queue: {
        queued: queue['created'] ?? 0,
        active: queue['active'] ?? 0,
        retry: queue['retry'] ?? 0,
        failed: queue['failed'] ?? 0,
      },
      rate: { perMin: Math.round(perMin15 * 10) / 10, perHour },
      etaSeconds: perMin15 > 0 && pending > 0 ? Math.round((pending / perMin15) * 60) : null,
      reasons,
      series,
      sources,
      fastPath: {
        eligible: fp?.['eligible'] ?? 0,
        viaMbid: fp?.['via_mbid'] ?? 0,
        viaOther: fp?.['via_other'] ?? 0,
        undecided: fp?.['undecided'] ?? 0,
        pending: fp?.['pending'] ?? 0,
      },
      sweep: sweep ? {
        id: sweep.id,
        state: sweep.state,
        progress: sweep.progress,
        startedAt: sweep.startedAt?.toISOString() ?? null,
        finishedAt: sweep.finishedAt?.toISOString() ?? null,
      } : null,
    });
  });

  fastify.get('/libraries/:libraryId/identify/triage', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    await ownedLibrary(request.user.id, libraryId);
    const q = request.query as { reason?: string; q?: string; limit?: string; offset?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '100', 10) || 100, 1), 500);
    const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);
    const reason = q.reason && (IDENTIFY_REASONS as readonly string[]).includes(q.reason) ? q.reason as IdentifyReason : undefined;
    const search = q.q?.trim() ? `%${q.q.trim()}%` : null;
    const db = getDb();

    if (reason === 'job_failed') {
      // Albums still pending whose identify job exhausted pg-boss retries.
      const rows = await db.execute(sql`
        select la.id, la.title_guess, la.artist_guess, la.year_guess, la.track_count, la.formats,
               la.dir_paths[1] as dir_path, la.identify_attempts, la.last_identify_at, la.state,
               f.error, f.failed_at
          from (select distinct on (j.data->>'localAlbumId') (j.data->>'localAlbumId')::uuid as album_id,
                       coalesce(j.output->>'message', j.output::text) as error, j.completed_on as failed_at
                  from pgboss.job j where j.name = 'identify.album' and j.state = 'failed' and ${NO_LIVE_JOB}
                 order by j.data->>'localAlbumId', j.completed_on desc) f
          join local_albums la on la.id = f.album_id
         where la.library_id = ${libraryId} and la.state = 'pending'
           ${search ? sql`and (la.title_guess ilike ${search} or la.artist_guess ilike ${search})` : sql``}
         order by f.failed_at desc
         limit ${limit} offset ${offset}`) as unknown as Array<Record<string, unknown>>;
      reply.send({
        items: rows.map((r) => ({
          id: r['id'],
          title: r['title_guess'],
          artist: r['artist_guess'],
          year: r['year_guess'],
          trackCount: r['track_count'],
          formats: r['formats'] ?? [],
          dirPath: r['dir_path'],
          state: r['state'],
          reason: 'job_failed',
          attempts: r['identify_attempts'],
          lastIdentifyAt: r['last_identify_at'] ? new Date(r['last_identify_at'] as string).toISOString() : null,
          error: r['error'] ? String(r['error']).slice(0, 300) : null,
          best: null,
        })),
        limit,
        offset,
      });
      return;
    }

    const rows = await db.execute(sql`
      select la.id, la.title_guess, la.artist_guess, la.year_guess, la.track_count, la.formats,
             la.dir_paths[1] as dir_path, la.identify_reason, la.identify_attempts, la.last_identify_at, la.state,
             b.distance as best_distance, b.source as best_source, r.title as best_title, extract(year from r.date)::int as best_year,
             count(*) over() as total
        from local_albums la
        left join lateral (
          select mc.release_id, mc.distance, mc.source from match_candidates mc
           where mc.local_album_id = la.id order by mc.distance asc limit 1) b on true
        left join releases r on r.id = b.release_id
       where la.library_id = ${libraryId} and la.state = 'unidentified'
         ${reason ? sql`and la.identify_reason = ${reason}` : sql``}
         ${search ? sql`and (la.title_guess ilike ${search} or la.artist_guess ilike ${search})` : sql``}
       order by la.last_identify_at desc nulls last, la.created_at
       limit ${limit} offset ${offset}`) as unknown as Array<Record<string, unknown>>;
    reply.send({
      items: rows.map((r) => ({
        id: r['id'],
        title: r['title_guess'],
        artist: r['artist_guess'],
        year: r['year_guess'],
        trackCount: r['track_count'],
        formats: r['formats'] ?? [],
        dirPath: r['dir_path'],
        state: r['state'],
        reason: r['identify_reason'] ?? 'unknown',
        attempts: r['identify_attempts'],
        lastIdentifyAt: r['last_identify_at'] ? new Date(r['last_identify_at'] as string).toISOString() : null,
        error: null,
        best: r['best_title'] ? {
          title: r['best_title'],
          year: r['best_year'],
          distance: Number(r['best_distance']),
          source: r['best_source'],
        } : null,
      })),
      total: Number(rows[0]?.['total'] ?? 0),
      limit,
      offset,
    });
  });

  fastify.post('/libraries/:libraryId/identify/retry', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    await ownedLibrary(request.user.id, libraryId);
    const body = (request.body ?? {}) as { albumIds?: string[]; reason?: string };
    const db = getDb();

    let ids: string[];
    if (Array.isArray(body.albumIds) && body.albumIds.length) {
      const rows = await db.execute(sql`
        select id from local_albums where library_id = ${libraryId}
           and id = any(${body.albumIds.slice(0, RETRY_CAP)}::uuid[])`) as unknown as Array<{ id: string }>;
      ids = rows.map((r) => r.id);
    } else if (body.reason === 'job_failed') {
      const rows = await db.execute(sql`
        select distinct la.id from pgboss.job j
          join local_albums la on la.id = (j.data->>'localAlbumId')::uuid
         where j.name = 'identify.album' and j.state = 'failed' and ${NO_LIVE_JOB}
           and la.library_id = ${libraryId} and la.state = 'pending'
         limit ${RETRY_CAP}`) as unknown as Array<{ id: string }>;
      ids = rows.map((r) => r.id);
    } else if (body.reason && (IDENTIFY_REASONS as readonly string[]).includes(body.reason)) {
      const rows = await db.execute(sql`
        select id from local_albums where library_id = ${libraryId}
           and state = 'unidentified' and identify_reason = ${body.reason}
         order by last_identify_at asc nulls first limit ${RETRY_CAP}`) as unknown as Array<{ id: string }>;
      ids = rows.map((r) => r.id);
    } else {
      throw new ApiError(400, 'Bad Request', 'albumIds or a reason is required');
    }

    const boss = await getBoss();
    let enqueued = 0;
    for (const id of ids) {
      const jobId = await boss.send('identify.album', { localAlbumId: id, force: true }, {
        singletonKey: IDENTIFY_SINGLETON(id),
        priority: IDENTIFY_PRIORITY.retry,
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
      });
      if (jobId) enqueued++;
    }
    reply.status(202).send({ selected: ids.length, enqueued });
  });

  fastify.post('/libraries/:libraryId/identify/sweep', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    await ownedLibrary(request.user.id, libraryId);
    const boss = await getBoss();
    await boss.send('identify.sweep', { libraryId, topUp: true }, { singletonKey: `identify.sweep:${libraryId}` });
    reply.status(202).send({ ok: true });
  });

  // Owner-initiated identification requests still waiting (pinned ids,
  // re-identify) with their position in the queue; the sweep's own jobs are
  // not listed here.
  fastify.get('/libraries/:libraryId/identify/requests', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    await ownedLibrary(request.user.id, libraryId);
    reply.send({ items: await listPendingIdentifyRequests(libraryId) });
  });

  fastify.post('/libraries/:libraryId/identify/requests/:albumId/cancel', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
    await ownedLibrary(request.user.id, libraryId);
    const pending = await pendingIdentifyJob(albumId);
    if (!pending) throw new ApiError(404, 'Not Found', 'No identification request is queued for this album');
    await cancelIdentifyJob(await getBoss(), pending.id);
    reply.send({ cancelled: pending.id, wasActive: pending.state === 'active' });
  });
}
