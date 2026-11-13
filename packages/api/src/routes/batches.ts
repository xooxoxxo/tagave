/**
 * Accept batches: sets of albums accepted at once, by the owner's rules or
 * by a decider run, and the pace of the nightly bridge they feed.
 *
 *   GET  /libraries/:lib/batches               the newest 50, with counts and bridging still to come
 *   GET  /libraries/:lib/batches/:batchId      one batch: what it skipped or left, what an undo cannot take back
 *   POST /libraries/:lib/batches/:batchId/undo undo it (worker job); a model's batch needs system.manage
 *   PUT  /libraries/:lib/enrich-pace           "Drain faster": releases per nightly bridge run
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  BATCH_CANNOT_UNDO, ENRICH_PACES, batchDrainEstimates, drainEstimate, failStaleBatches, getBatch, isEnrichPace, liveDeciderJobs,
  renewUndo, requestUndo,
  sendDeciderAccept, type BatchRow,
} from '@tagave/db';
import {
  SKIP_LABELS, batchFailedDuring, deciderLabel, pendingLabel,
  type BatchDetail, type BatchItemView, type BatchSummary, type DrainEstimate,
} from '@tagave/shared';
import { getSql } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';
import { callerCan, NOT_AVAILABLE } from '../permissions/guard.js';

const LIST_LIMIT = 50;
/** skipped and left albums listed per batch; the counts hold the totals */
const ITEMS_LIMIT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Counts = BatchSummary['counts'];
const NO_COUNTS: Counts = { accepted: 0, skipped: 0, undone: 0, left: 0, pending: 0 };

async function assertLibrary(libraryId: string): Promise<void> {
  if (!UUID.test(libraryId)) throw new ApiError(404, 'Not Found', 'Library not found');
  const [row] = await getSql()`select 1 as x from libraries where id = ${libraryId}`;
  if (!row) throw new ApiError(404, 'Not Found', 'Library not found');
}

async function batchOf(libraryId: string, batchId: string): Promise<BatchRow> {
  await assertLibrary(libraryId);
  const batch = UUID.test(batchId) ? await getBatch(getSql(), batchId) : null;
  if (!batch || batch.libraryId !== libraryId) throw new ApiError(404, 'Not Found', 'Batch not found');
  return batch;
}

/** Downstream bridging only means something once albums were accepted. */
const hasDrain = (state: string): boolean => state === 'accepted';

async function countsFor(batchIds: string[]): Promise<Map<string, Counts>> {
  const out = new Map<string, Counts>();
  if (batchIds.length === 0) return out;
  const rows = await getSql()<Array<{ batch_id: string; status: keyof Counts; n: number }>>`
    select batch_id, status, count(*)::int as n
      from decider_batch_items where batch_id = any(${batchIds}::uuid[])
     group by batch_id, status`;
  for (const r of rows) {
    const c = out.get(r.batch_id) ?? { ...NO_COUNTS };
    if (r.status in c) c[r.status] += r.n;
    out.set(r.batch_id, c);
  }
  return out;
}

interface ListedRow {
  id: string; decider_id: string; decider_version: string | null; decided_kind: 'rule' | 'model'; band: string | null;
  state: string; created_at: string | Date; message: string | null; started_by: string | null;
}

function summary(r: ListedRow, counts: Counts | undefined, drain: DrainEstimate | null): BatchSummary {
  return {
    id: r.id,
    deciderId: r.decider_id,
    deciderLabel: deciderLabel(r.decider_id, r.decider_version),
    decidedKind: r.decided_kind,
    band: r.band,
    state: r.state,
    createdAt: new Date(r.created_at).toISOString(),
    startedBy: r.started_by,
    counts: counts ?? { ...NO_COUNTS },
    pendingLabel: pendingLabel(r.state),
    failedDuring: batchFailedDuring(r.state, r.message),
    message: r.message,
    drain,
  };
}

async function listedRows(libraryId: string, batchId?: string): Promise<ListedRow[]> {
  const one = batchId ?? null;
  return getSql()<ListedRow[]>`
    select b.id, b.decider_id, b.decider_version, b.decided_kind, b.band, b.state, b.created_at, b.message,
           u.display_name as started_by
      from decider_batches b
      left join users u on u.id = b.started_by_user_id
     where b.library_id = ${libraryId} and (${one}::uuid is null or b.id = ${one}::uuid)
     order by b.created_at desc, b.id desc
     limit ${LIST_LIMIT}`;
}

async function itemsOf(batchId: string, status: 'skipped' | 'left'): Promise<BatchItemView[]> {
  // left join: an album merged or removed since shows without a title
  const rows = await getSql()<Array<{ local_album_id: string; title_guess: string | null; artist_guess: string | null; skip_reason: string }>>`
    select i.local_album_id, la.title_guess, la.artist_guess, i.skip_reason
      from decider_batch_items i
      left join local_albums la on la.id = i.local_album_id
     where i.batch_id = ${batchId} and i.status = ${status}
     order by i.position
     limit ${ITEMS_LIMIT}`;
  return rows.map((r) => ({
    albumId: r.local_album_id,
    title: r.title_guess ?? null,
    artist: r.artist_guess ?? null,
    reason: SKIP_LABELS[r.skip_reason] ?? r.skip_reason,
  }));
}

/**
 * Batches whose run died without marking them read failed before they are
 * listed, not accepting or undoing for hours until the nightly check. One
 * update over the library's active batches; a failure here only logs.
 */
async function settleStale(request: FastifyRequest, libraryId: string): Promise<void> {
  try {
    await failStaleBatches(getSql(), { libraryId });
  } catch (err) {
    request.log.warn({ libraryId, err: err instanceof Error ? err.message : String(err) }, 'stale accept batch check failed');
  }
}

/**
 * Queues the undo run. Under the queue's stately policy a send comes back
 * empty when a run of this batch is already queued: fine when that run is
 * an undo. A queued accept is cancelled and the undo queued in its place
 * (pg-boss also cancels one that just went active; that run's
 * compare-and-set on queued/accepting fails once the batch is undoing, so
 * it stops without accepting anything). False when nothing got queued.
 */
async function queueUndo(batchId: string): Promise<boolean> {
  const boss = await getBoss();
  if (await sendDeciderAccept(boss, batchId, 'undo')) return true;
  const live = await liveDeciderJobs(getSql(), batchId);
  if (live.some((j) => j.mode === 'undo')) return true;
  const waitingAccepts = live.filter((j) => j.mode === 'accept' && j.state === 'created').map((j) => j.id);
  if (waitingAccepts.length === 0) return false;
  await boss.cancel('decider.accept', waitingAccepts);
  return Boolean(await sendDeciderAccept(boss, batchId, 'undo'));
}

export async function createBatchRoutes(fastify: FastifyInstance) {
  fastify.get('/libraries/:libraryId/batches', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(libraryId);
    await settleStale(request, libraryId);
    const rows = await listedRows(libraryId);
    const ids = rows.map((r) => r.id);
    const counts = await countsFor(ids);
    const drains = await batchDrainEstimates(getSql(), libraryId, rows.filter((r) => hasDrain(r.state)).map((r) => r.id));
    reply.send({ items: rows.map((r) => summary(r, counts.get(r.id), drains.get(r.id) ?? null)) });
  });

  fastify.get('/libraries/:libraryId/batches/:batchId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId, batchId } = request.params as { libraryId: string; batchId: string };
    await assertLibrary(libraryId);
    if (!UUID.test(batchId)) throw new ApiError(404, 'Not Found', 'Batch not found');
    await settleStale(request, libraryId);
    const [row] = await listedRows(libraryId, batchId);
    if (!row) throw new ApiError(404, 'Not Found', 'Batch not found');
    const counts = (await countsFor([batchId])).get(batchId);
    const drain = hasDrain(row.state) ? await drainEstimate(getSql(), libraryId, batchId) : null;
    const detail: BatchDetail = {
      ...summary(row, counts, drain),
      skipped: await itemsOf(batchId, 'skipped'),
      left: await itemsOf(batchId, 'left'),
      cannotUndo: BATCH_CANNOT_UNDO,
    };
    reply.send(detail);
  });

  fastify.post('/libraries/:libraryId/batches/:batchId/undo', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId, batchId } = request.params as { libraryId: string; batchId: string };
    const batch = await batchOf(libraryId, batchId);
    // a model's decisions are the install's; the owner's rules are library care
    if (batch.decidedKind === 'model' && !callerCan(request, 'system.manage')) throw new ApiError(403, 'Forbidden', NOT_AVAILABLE);
    // asked before and maybe not queued then: renew the time and queue it
    // (a run already queued stays the one); else ask for the undo now
    const asked = (batch.state === 'undoing' && (await renewUndo(getSql(), batchId)))
      || (await requestUndo(getSql(), batchId, request.user.id));
    if (!asked) {
      throw new ApiError(409, 'Conflict', 'Batch cannot be undone now');
    }
    if (!(await queueUndo(batchId))) throw new ApiError(503, 'Service Unavailable', 'Undo not queued');
    reply.status(202).send({ ok: true });
  });

  fastify.put('/libraries/:libraryId/enrich-pace', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const { limit } = (request.body ?? {}) as { limit?: unknown };
    if (!isEnrichPace(limit)) throw new ApiError(400, 'Bad Request', `limit: one of ${ENRICH_PACES.join(', ')}`);
    await assertLibrary(libraryId);
    // older rows may hold the settings as a JSON string; keep what they say
    await getSql()`
      update libraries
         set settings = jsonb_set(
               case jsonb_typeof(settings) when 'object' then settings
                                           when 'string' then coalesce((settings #>> '{}')::jsonb, '{}'::jsonb)
                                           else '{}'::jsonb end,
               '{enrichSweepLimit}', to_jsonb(${limit}::int))
       where id = ${libraryId}`;
    reply.send({ limit, drain: await drainEstimate(getSql(), libraryId) });
  });
}
