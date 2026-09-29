/**
 * Manual identification requests (IDN-6): one pending identify.album job per
 * album, jumping the sweep's FIFO, visible on the album page and on
 * /identify, cancellable. The sweep enqueues at priority 0; an owner click
 * must not wait behind ~15k sweep jobs (a pinned MBID sat 14,904 deep on
 * 2026-09-08).
 */
import { sql } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import type { IdentifyOutcomeKind, IdentifyOutcomeView, IdentifyRequestView, ReleaseChoice } from '@liner/shared';
import { getDb } from '../db.js';

export const IDENTIFY_PRIORITY = { manual: 100, retry: 50, sweep: 0 } as const;
export const IDENTIFY_SINGLETON = (albumId: string) => `identify:${albumId}`;

export type IdentifyRequestKind = 'mbid' | 'release_group' | 'discogs' | 'reidentify' | 'sweep';

/** What a queued identify.album job is for, from its data payload. */
export function classifyIdentifyJob(data: unknown): { kind: IdentifyRequestKind; pinned: string | null } {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (typeof d['pinnedReleaseGroup'] === 'string' && d['pinnedReleaseGroup']) return { kind: 'release_group', pinned: d['pinnedReleaseGroup'] };
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

/** pinned or forced: an owner request, not the sweep */
const MANUAL_JOB = sql`(j.data ? 'pinnedMbid' or j.data ? 'pinnedReleaseGroup' or j.data ? 'pinnedDiscogs' or (j.data->>'force')::boolean is true)`;

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
       and ${MANUAL_JOB}
     order by j.priority desc, j.created_on asc
     limit ${limit}`) as unknown as PendingRow[];
  return rows.map((r) => ({
    ...toPending(r),
    album: { id: r.local_album_id as string, title: r.title_guess ?? null, artist: r.artist_guess ?? null, state: r.album_state as string },
  }));
}

/** identify_runs row: how a finished owner request ended (worker-recorded). */
export interface IdentifyRunRow {
  job_id: string | null;
  kind: string;
  pinned: string | null;
  outcome: string;
  message: string;
  detail: unknown;
  finished_at: string | Date;
}

/** The newest owner-initiated identify.album job for an album, in any state. */
export interface IdentifyJobRow {
  id: string;
  state: string;
  data: unknown;
  output: unknown;
  created_on: string | Date;
  completed_on: string | Date | null;
}

const iso = (d: string | Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

const OUTCOMES: readonly IdentifyOutcomeKind[] = ['matched', 'needs_review', 'unidentified', 'release_group', 'not_found', 'failed', 'cancelled', 'skipped', 'unknown'];

function outcomeFromRun(r: IdentifyRunRow): IdentifyOutcomeView {
  const d = (r.detail && typeof r.detail === 'object' ? r.detail : {}) as {
    releaseGroup?: { mbid: string; title: string }; choices?: ReleaseChoice[]; moreChoices?: number;
  };
  const kind = (OUTCOMES as readonly string[]).includes(r.outcome) ? r.outcome as IdentifyOutcomeKind : 'unknown';
  return {
    kind,
    message: r.message,
    finishedAt: iso(r.finished_at)!,
    ...(d.releaseGroup ? { releaseGroup: d.releaseGroup } : {}),
    ...(d.choices ? { choices: d.choices } : {}),
    ...(d.moreChoices ? { moreChoices: d.moreChoices } : {}),
  };
}

/**
 * The owner's request for one album as the page shows it — from the live job
 * when there is one, else from the outcome the worker recorded, else (a job
 * that ended before outcomes were recorded) from the pg-boss end state. The
 * old page read only the live job and trusted a stale copy of it.
 */
export function deriveIdentifyRequest(
  pending: PendingIdentify | null,
  lastJob: IdentifyJobRow | null,
  lastRun: IdentifyRunRow | null,
): IdentifyRequestView | null {
  if (pending) {
    return {
      status: pending.state === 'active' ? 'running' : pending.state === 'retry' ? 'retrying' : 'queued',
      jobId: pending.id,
      kind: pending.kind,
      pinned: pending.pinned,
      createdAt: pending.createdAt,
      startedAt: pending.startedAt,
      jobsAhead: pending.state === 'created' ? pending.jobsAhead : 0,
      outcome: null,
    };
  }
  const runIsCurrent = lastRun && (!lastJob || lastRun.job_id === lastJob.id
    || new Date(lastRun.finished_at).getTime() >= new Date(lastJob.created_on).getTime());
  if (lastRun && runIsCurrent) {
    const kind = (['mbid', 'release_group', 'discogs', 'reidentify', 'sweep'] as const).find((k) => k === lastRun.kind) ?? 'reidentify';
    return {
      status: 'done',
      jobId: lastRun.job_id,
      kind,
      pinned: lastRun.pinned,
      createdAt: lastJob && lastJob.id === lastRun.job_id ? iso(lastJob.created_on) : null,
      startedAt: null,
      jobsAhead: 0,
      outcome: outcomeFromRun(lastRun),
    };
  }
  if (lastJob) {
    const c = classifyIdentifyJob(lastJob.data);
    const finishedAt = iso(lastJob.completed_on) ?? iso(lastJob.created_on)!;
    const outputMsg = (lastJob.output as { message?: string } | null)?.message;
    const outcome: IdentifyOutcomeView = lastJob.state === 'failed'
      ? { kind: 'failed', message: outputMsg ? `The lookup failed: ${outputMsg}` : 'The lookup failed.', finishedAt }
      : lastJob.state === 'cancelled'
        ? { kind: 'cancelled', message: 'The request was cancelled before it ran.', finishedAt }
        : { kind: 'unknown', message: 'It finished, but this version of Liner did not record the result yet. Submit it again to see why nothing changed.', finishedAt };
    return {
      status: 'done', jobId: lastJob.id, kind: c.kind, pinned: c.pinned,
      createdAt: iso(lastJob.created_on), startedAt: null, jobsAhead: 0, outcome,
    };
  }
  return null;
}

/** Live job + newest recorded outcome + newest owner job, derived into one view. */
export async function identifyRequestView(albumId: string): Promise<IdentifyRequestView | null> {
  const db = getDb();
  const [pending, jobs, runs] = await Promise.all([
    pendingIdentifyJob(albumId),
    db.execute(sql`
      select j.id, j.state, j.data, j.output, j.created_on, j.completed_on
        from pgboss.job j
       where j.name = 'identify.album' and j.singleton_key = ${IDENTIFY_SINGLETON(albumId)} and ${MANUAL_JOB}
       order by j.created_on desc
       limit 1`) as unknown as Promise<IdentifyJobRow[]>,
    db.execute(sql`
      select job_id, kind, pinned, outcome, message, detail, finished_at
        from identify_runs
       where local_album_id = ${albumId}
       order by finished_at desc
       limit 1`) as unknown as Promise<IdentifyRunRow[]>,
  ]);
  return deriveIdentifyRequest(pending, jobs[0] ?? null, runs[0] ?? null);
}

/** Record that the owner cancelled a queued request (it never ran). */
export async function recordCancelled(albumId: string, pending: PendingIdentify): Promise<void> {
  await getDb().execute(sql`
    insert into identify_runs (library_id, local_album_id, job_id, kind, pinned, outcome, message)
    select la.library_id, la.id, ${pending.id}::uuid, ${pending.kind}, ${pending.pinned}, 'cancelled', 'You cancelled this request before it ran.'
      from local_albums la where la.id = ${albumId}`);
}

/** Cancel a queued request. An active job keeps running to completion (pg-boss
 * cannot interrupt a handler); the caller sees state 'active' and decides. */
export async function cancelIdentifyJob(boss: PgBoss, jobId: string): Promise<void> {
  await boss.cancel('identify.album', jobId);
}

/**
 * Cancel identify jobs still waiting for albums that were just removed (merged
 * into another). A running one stops quietly on its own when it finds the
 * album gone.
 */
export async function cancelQueuedIdentifyFor(boss: PgBoss, albumIds: readonly string[]): Promise<number> {
  if (albumIds.length === 0) return 0;
  const rows = await getDb().execute(sql`
    select id, name from pgboss.job
     where name in ('identify.album', 'identify.acoustid')
       and state in ('created', 'retry')
       and data->>'localAlbumId' in (${sql.join(albumIds.map((id) => sql`${id}`), sql`, `)})`) as unknown as Array<{ id: string; name: string }>;
  for (const name of ['identify.album', 'identify.acoustid']) {
    const ids = rows.filter((r) => r.name === name).map((r) => r.id);
    if (ids.length > 0) await boss.cancel(name, ids);
  }
  return rows.length;
}
