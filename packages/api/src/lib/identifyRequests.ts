/**
 * Manual identification requests (IDN-6): one pending identify.album job per
 * album, jumping the sweep's FIFO, visible on the album page and on
 * /identify, cancellable. The sweep enqueues at priority 0; an owner click
 * must not wait behind ~15k sweep jobs (a pinned MBID sat 14,904 deep on
 * 2026-09-08).
 */
import { sql } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { getDb } from '../db.js';

export const IDENTIFY_PRIORITY = { manual: 100, retry: 50, sweep: 0 } as const;
export const IDENTIFY_SINGLETON = (albumId: string) => `identify:${albumId}`;

export type IdentifyRequestKind = 'mbid' | 'discogs' | 'reidentify' | 'sweep';

/** What a queued identify.album job is for, from its data payload. */
export function classifyIdentifyJob(data: unknown): { kind: IdentifyRequestKind; pinned: string | null } {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (typeof d['pinnedMbid'] === 'string' && d['pinnedMbid']) return { kind: 'mbid', pinned: d['pinnedMbid'] };
  const pd = d['pinnedDiscogs'];
  if (pd && typeof pd === 'object' && (pd as { id?: unknown }).id !== undefined) {
    const p = pd as { kind?: string; id: number | string };
    return { kind: 'discogs', pinned: `${p.kind ?? 'release'}:${p.id}` };
  }
  if (d['force'] === true) return { kind: 'reidentify', pinned: null };
  return { kind: 'sweep', pinned: null };
}

/** Position in the created queue: higher priority first, then FIFO. */
export function jobsAheadOf(job: { priority: number; createdAt: number }, others: Array<{ priority: number; createdAt: number }>): number {
  return others.filter((o) => o.priority > job.priority || (o.priority === job.priority && o.createdAt < job.createdAt)).length;
}

export interface PendingIdentify {
  id: string;
  state: 'created' | 'retry' | 'active';
  kind: IdentifyRequestKind;
  pinned: string | null;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  jobsAhead: number;
}

interface PendingRow {
  id: string; state: string; data: unknown; priority: number; created_on: string | Date; started_on: string | Date | null; jobs_ahead: number;
  local_album_id?: string; title_guess?: string | null; artist_guess?: string | null; album_state?: string;
}

function toPending(r: PendingRow): PendingIdentify {
  const c = classifyIdentifyJob(r.data);
  return {
    id: r.id,
    state: r.state as PendingIdentify['state'],
    kind: c.kind,
    pinned: c.pinned,
    priority: Number(r.priority),
    createdAt: new Date(r.created_on).toISOString(),
    startedAt: r.started_on ? new Date(r.started_on).toISOString() : null,
    jobsAhead: Number(r.jobs_ahead ?? 0),
  };
}

const JOBS_AHEAD = sql`(select count(*)::int from pgboss.job q
   where q.name = 'identify.album' and q.state = 'created'
     and (q.priority > j.priority or (q.priority = j.priority and q.created_on < j.created_on)))`;

/** The one live identify job for an album (created / retry / active), or null. */
export async function pendingIdentifyJob(albumId: string): Promise<PendingIdentify | null> {
  const rows = await getDb().execute(sql`
    select j.id, j.state, j.data, j.priority, j.created_on, j.started_on, ${JOBS_AHEAD} as jobs_ahead
      from pgboss.job j
     where j.name = 'identify.album' and j.singleton_key = ${IDENTIFY_SINGLETON(albumId)}
       and j.state in ('created', 'retry', 'active')
     order by j.created_on desc
     limit 1`) as unknown as PendingRow[];
  const r = rows[0];
  return r ? toPending(r) : null;
}

export interface PendingIdentifyRequest extends PendingIdentify {
  album: { id: string; title: string | null; artist: string | null; state: string };
}

/** Owner-initiated requests (pinned or forced) still waiting, oldest first. */
export async function listPendingIdentifyRequests(libraryId: string, limit = 200): Promise<PendingIdentifyRequest[]> {
  const rows = await getDb().execute(sql`
    select j.id, j.state, j.data, j.priority, j.created_on, j.started_on, ${JOBS_AHEAD} as jobs_ahead,
           la.id as local_album_id, la.title_guess, la.artist_guess, la.state as album_state
      from pgboss.job j
      join local_albums la on la.id = (j.data->>'localAlbumId')::uuid
     where j.name = 'identify.album' and j.state in ('created', 'retry', 'active')
       and la.library_id = ${libraryId}
       and (j.data ? 'pinnedMbid' or j.data ? 'pinnedDiscogs' or (j.data->>'force')::boolean is true)
     order by j.priority desc, j.created_on asc
     limit ${limit}`) as unknown as PendingRow[];
  return rows.map((r) => ({
    ...toPending(r),
    album: { id: r.local_album_id as string, title: r.title_guess ?? null, artist: r.artist_guess ?? null, state: r.album_state as string },
  }));
}

/** Cancel a queued request. An active job keeps running to completion (pg-boss
 * cannot interrupt a handler); the caller sees state 'active' and decides. */
export async function cancelIdentifyJob(boss: PgBoss, jobId: string): Promise<void> {
  await boss.cancel('identify.album', jobId);
}
