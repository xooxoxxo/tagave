/**
 * Accept batches (0095): one decider_batches row per set of albums accepted
 * at once (the owner's auto-accept rules, or a decider run), and one
 * decider_batch_items row per album with what the accept found before it
 * (prior_*), so the whole batch can be undone.
 *
 * An item is pending until the accept handles it, then accepted or skipped
 * (skip_reason says why); an undo moves accepted items to undone, or leaves
 * them (status left, the reason in skip_reason) when the album changed since.
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

export type BatchState = 'queued' | 'accepting' | 'accepted' | 'undoing' | 'undone' | 'failed';
export type ItemStatus = 'pending' | 'accepted' | 'skipped' | 'undone' | 'left';
export type SkipReason = 'gone' | 'state' | 'reidentified' | 'release_gone' | 'evidence_changed';
export type LeftReason = 'gone' | 'state_changed' | 'newer_decision' | 'locks' | 'tag_plan';

export interface BatchItemInput {
  albumId: string; releaseId: string; distance: number; source: string | null; probability: number | null;
  evidenceHash: string | null; expectLastIdentifyAt: string | null; reason: string;
}
export interface CreateBatchInput {
  libraryId: string; deciderId: string; deciderVersion: string | null; decidedKind: 'rule' | 'model';
  startedByUserId: string | null; runId?: string | null; band?: string | null;
  /** default ['needs_review'] */
  acceptFrom?: string[];
  items: BatchItemInput[];
}
export interface BatchRow {
  id: string; libraryId: string; deciderId: string; deciderVersion: string | null; decidedKind: 'rule' | 'model';
  runId: string | null; band: string | null; acceptFrom: string[]; state: BatchState; startedByUserId: string | null;
  createdAt: Date; acceptedAt: Date | null; undoneAt: Date | null;
  message: string | null; undoRequestedAt: Date | null; undoByUserId: string | null;
}
export interface BatchItemRow {
  id: string; batchId: string; localAlbumId: string; releaseId: string; distance: number; source: string | null;
  probability: number | null; evidenceHash: string | null; expectLastIdentifyAt: Date | null; reason: string;
  status: ItemStatus; skipReason: string | null; matchId: string | null; priorState: string | null;
  priorIdentifyReason: string | null; priorReleaseId: string | null; priorReleaseGroupId: string | null;
  priorIdentifiedAt: Date | null; priorMatchId: string | null; priorMatchStatus: string | null;
  priorMatchReason: string | null; acceptedAt: Date | null; undoneAt: Date | null;
}

/** What an undo cannot take back, for the accept dialog. */
export const BATCH_CANNOT_UNDO: readonly string[] = Object.freeze(['Album identity already pulled by linked apps', 'Tag plans already applied']);

const ITEM_STATUSES: readonly ItemStatus[] = ['pending', 'accepted', 'skipped', 'undone', 'left'];

// the shared client returns timestamptz as text, a plain client as a Date
const toDate = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)));
const toNum = (v: unknown): number | null => (v == null ? null : Number(v));
const toText = (v: number | string | null): string | null => (v == null ? null : String(v));

/**
 * Creates a queued batch and its items in one transaction (a savepoint when
 * the caller is in one). Items go in with one set-based insert; each item's
 * position is its place in the input, which is the order readers get.
 * The same album twice in one batch is refused (unique), and nothing is kept.
 */
export async function createBatch(sql: Sql, input: CreateBatchInput): Promise<string> {
  const items = input.items;
  // A model's decision is pinned to the evidence it saw and to the identify
  // run it followed; without both, the accept could not tell that either moved.
  if (input.decidedKind === 'model') {
    const unpinned = items.findIndex((i) => i.evidenceHash == null || i.expectLastIdentifyAt == null);
    if (unpinned >= 0) throw new RangeError(`a model batch item needs an evidence hash and an identify time (item ${unpinned + 1})`);
  }
  const run = async (tx: Sql): Promise<string> => {
    const [b] = await tx<Array<{ id: string }>>`
      insert into decider_batches (library_id, decider_id, decider_version, decided_kind, run_id, band, accept_from, started_by_user_id)
      values (${input.libraryId}, ${input.deciderId}, ${input.deciderVersion}, ${input.decidedKind}, ${input.runId ?? null},
              ${input.band ?? null}, ${input.acceptFrom ?? ['needs_review']}::text[],
              -- a starter deleted since the click leaves the batch without one, never a failed insert
              (select id from users where id = ${input.startedByUserId}::uuid))
      returning id`;
    const batchId = b!.id;
    if (items.length === 0) return batchId;
    const albums = items.map((i) => i.albumId);
    const rels = items.map((i) => i.releaseId);
    const dists = items.map((i) => String(i.distance));
    const sources = items.map((i) => i.source);
    const probs = items.map((i) => toText(i.probability));
    const hashes = items.map((i) => i.evidenceHash);
    const expects = items.map((i) => i.expectLastIdentifyAt);
    const reasons = items.map((i) => i.reason);
    await tx`
      insert into decider_batch_items (batch_id, local_album_id, release_id, distance, source, probability,
                                       evidence_hash, expect_last_identify_at, reason, position)
      select ${batchId}, u.album, u.rel, u.dist, u.src, u.prob, u.hash, u.expect, u.reason, u.ord
        from unnest(${albums}::text[]::uuid[], ${rels}::text[]::uuid[], ${dists}::text[]::numeric[],
                    ${sources}::text[], ${probs}::text[]::numeric[], ${hashes}::text[],
                    ${expects}::text[]::timestamptz[], ${reasons}::text[])
             with ordinality as u(album, rel, dist, src, prob, hash, expect, reason, ord)
       order by u.ord`;
    return batchId;
  };
  if ('savepoint' in sql) return (sql as postgres.TransactionSql<any>).savepoint((tx) => run(tx));
  return (sql as postgres.Sql<any>).begin((tx) => run(tx)) as Promise<string>;
}

export async function getBatch(sql: Sql, batchId: string): Promise<BatchRow | null> {
  const [r] = await sql<Array<Record<string, unknown>>>`
    select id, library_id, decider_id, decider_version, decided_kind, run_id, band, accept_from, state,
           started_by_user_id, created_at, accepted_at, undone_at, message, undo_requested_at, undo_by_user_id
      from decider_batches where id = ${batchId}`;
  if (!r) return null;
  return {
    id: r['id'] as string,
    libraryId: r['library_id'] as string,
    deciderId: r['decider_id'] as string,
    deciderVersion: (r['decider_version'] as string | null) ?? null,
    decidedKind: r['decided_kind'] as 'rule' | 'model',
    runId: (r['run_id'] as string | null) ?? null,
    band: (r['band'] as string | null) ?? null,
    acceptFrom: (r['accept_from'] as string[]) ?? [],
    state: r['state'] as BatchState,
    startedByUserId: (r['started_by_user_id'] as string | null) ?? null,
    createdAt: toDate(r['created_at'])!,
    acceptedAt: toDate(r['accepted_at']),
    undoneAt: toDate(r['undone_at']),
    message: (r['message'] as string | null) ?? null,
    undoRequestedAt: toDate(r['undo_requested_at']),
    undoByUserId: (r['undo_by_user_id'] as string | null) ?? null,
  };
}

/**
 * Asks for a batch to be undone: moves it to undoing and says who asked and
 * when. Allowed while it is still accepting (that run stops after the chunk
 * in hand), once accepted, and after a failure (the chunks before it stay
 * accepted). False when the batch is in none of those states. The caller
 * then queues the undo with sendDeciderAccept(boss, batchId, 'undo').
 */
export async function requestUndo(sql: Sql, batchId: string, userId: string | null): Promise<boolean> {
  const rows = await sql`
    update decider_batches
       set state = 'undoing', undo_requested_at = now(), undo_by_user_id = ${userId}
     where id = ${batchId} and state in ('accepting', 'accepted', 'failed')
     returning id`;
  return rows.length > 0;
}

/**
 * An undo asked again while the batch is still undoing (its run was not
 * queued the first time): stamps the new time, so the stale check sees the
 * batch as moving. False when the batch is no longer undoing.
 */
export async function renewUndo(sql: Sql, batchId: string): Promise<boolean> {
  const rows = await sql`
    update decider_batches set undo_requested_at = now()
     where id = ${batchId} and state = 'undoing'
     returning id`;
  return rows.length > 0;
}

/** Moves a batch to `state`; accepted stamps accepted_at, undone stamps undone_at. `message` replaces the batch's message when given. */
export async function setBatchState(sql: Sql, batchId: string, state: BatchState, extra: { message?: string } = {}): Promise<void> {
  const hasMessage = extra.message !== undefined;
  await sql`
    update decider_batches
       set state = ${state},
           accepted_at = case when ${state}::text = 'accepted' then now() else accepted_at end,
           undone_at = case when ${state}::text = 'undone' then now() else undone_at end,
           message = case when ${hasMessage}::boolean then ${extra.message ?? null}::text else message end
     where id = ${batchId}`;
}

/**
 * Moves a batch to `to` only while it is in one of `from` (stamps and
 * message as setBatchState). False when the batch was elsewhere or gone:
 * someone else moved it, and the caller leaves it be.
 */
export async function transitionBatch(
  sql: Sql, batchId: string, from: readonly BatchState[], to: BatchState, extra: { message?: string } = {},
): Promise<boolean> {
  const hasMessage = extra.message !== undefined;
  const rows = await sql`
    update decider_batches
       set state = ${to},
           accepted_at = case when ${to}::text = 'accepted' then now() else accepted_at end,
           undone_at = case when ${to}::text = 'undone' then now() else undone_at end,
           message = case when ${hasMessage}::boolean then ${extra.message ?? null}::text else message end
     where id = ${batchId} and state = any(${[...from]}::text[])
     returning id`;
  return rows.length > 0;
}

/** What sending a job needs (a PgBoss instance fits). */
export interface JobSender {
  send(name: string, data: object, options: { singletonKey: string }): Promise<string | null>;
}

/**
 * The one way to queue decider.accept: every run of a batch, accept or
 * undo, carries the batch's key, so under the queue's stately policy two
 * runs of one batch never work at once. No throttle window: a send must
 * never be swallowed by an earlier completed run.
 */
export async function sendDeciderAccept(boss: JobSender, batchId: string, mode: 'accept' | 'undo' = 'accept'): Promise<string | null> {
  return boss.send('decider.accept', { batchId, mode }, { singletonKey: `decider:${batchId}` });
}

/** Up to `limit` items of a batch with this status, in the order they were added. */
export async function itemsWithStatus(sql: Sql, batchId: string, status: ItemStatus, limit: number): Promise<BatchItemRow[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    select id, batch_id, local_album_id, release_id, distance, source, probability, evidence_hash,
           expect_last_identify_at, reason, status, skip_reason, match_id, prior_state, prior_identify_reason,
           prior_release_id, prior_release_group_id, prior_identified_at, prior_match_id, prior_match_status,
           prior_match_reason, accepted_at, undone_at
      from decider_batch_items
     where batch_id = ${batchId} and status = ${status}
     order by position
     limit ${limit}`;
  return rows.map((r) => ({
    id: r['id'] as string,
    batchId: r['batch_id'] as string,
    localAlbumId: r['local_album_id'] as string,
    releaseId: r['release_id'] as string,
    distance: Number(r['distance']),
    source: (r['source'] as string | null) ?? null,
    probability: toNum(r['probability']),
    evidenceHash: (r['evidence_hash'] as string | null) ?? null,
    expectLastIdentifyAt: toDate(r['expect_last_identify_at']),
    reason: r['reason'] as string,
    status: r['status'] as ItemStatus,
    skipReason: (r['skip_reason'] as string | null) ?? null,
    matchId: (r['match_id'] as string | null) ?? null,
    priorState: (r['prior_state'] as string | null) ?? null,
    priorIdentifyReason: (r['prior_identify_reason'] as string | null) ?? null,
    priorReleaseId: (r['prior_release_id'] as string | null) ?? null,
    priorReleaseGroupId: (r['prior_release_group_id'] as string | null) ?? null,
    priorIdentifiedAt: toDate(r['prior_identified_at']),
    priorMatchId: (r['prior_match_id'] as string | null) ?? null,
    priorMatchStatus: (r['prior_match_status'] as string | null) ?? null,
    priorMatchReason: (r['prior_match_reason'] as string | null) ?? null,
    acceptedAt: toDate(r['accepted_at']),
    undoneAt: toDate(r['undone_at']),
  }));
}

/**
 * Items per status, and the skipped and left items per reason. The table
 * requires a reason on every skipped and left item, so every one is counted
 * under its reason.
 */
export async function batchCounts(
  sql: Sql, batchId: string,
): Promise<Record<ItemStatus, number> & { skipped_by: Record<string, number>; left_by: Record<string, number> }> {
  const rows = await sql<Array<{ status: string; skip_reason: string | null; n: number }>>`
    select status, skip_reason, count(*)::int as n
      from decider_batch_items where batch_id = ${batchId}
     group by status, skip_reason`;
  const out = {
    ...(Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0])) as Record<ItemStatus, number>),
    skipped_by: {} as Record<string, number>,
    left_by: {} as Record<string, number>,
  };
  for (const r of rows) {
    const status = r.status as ItemStatus;
    out[status] += r.n;
    const by = status === 'skipped' ? out.skipped_by : status === 'left' ? out.left_by : null;
    if (by && r.skip_reason) by[r.skip_reason] = (by[r.skip_reason] ?? 0) + r.n;
  }
  return out;
}

/** How long one decider.accept run may work before pg-boss expires it (the worker's queue option). */
export const DECIDER_ACCEPT_EXPIRE_SECONDS = 6 * 3600;

/** decider.accept jobs of a batch that are queued, waiting to retry or running, with their mode. */
export async function liveDeciderJobs(sql: Sql, batchId: string): Promise<Array<{ id: string; state: string; mode: 'accept' | 'undo' }>> {
  const rows = await sql<Array<{ id: string; state: string; mode: string | null }>>`
    select id::text as id, state::text as state, data->>'mode' as mode
      from pgboss.job
     where name = 'decider.accept' and singleton_key = ${`decider:${batchId}`}
       and state::text in ('created', 'retry', 'active')`;
  return rows.map((r) => ({ id: r.id, state: r.state, mode: r.mode === 'undo' ? 'undo' : 'accept' }));
}

/**
 * Fails batches left queued, accepting or undoing by a run that will not
 * come back: pg-boss expired its job (or the worker died) after its last
 * retry, so the run's own catch never marked the batch. A batch is stale
 * when nothing moved in it for longer than one run may take and no
 * decider.accept job for it is queued, waiting or running. One statement
 * checks both and fails the batch, so a run queued meanwhile (an undo asked
 * again) keeps its batch. The message starts like a run's own failure
 * ("Accept stopped:" / "Undo stopped:"). Returns the batches it failed.
 */
export async function failStaleBatches(
  sql: Sql, opts: { libraryId?: string; olderThanSeconds?: number } = {},
): Promise<string[]> {
  const seconds = opts.olderThanSeconds ?? DECIDER_ACCEPT_EXPIRE_SECONDS;
  const lib = opts.libraryId ?? null;
  const rows = await sql<Array<{ id: string }>>`
    update decider_batches b
       set state = 'failed',
           message = case when b.state = 'undoing' then 'Undo stopped: no progress' else 'Accept stopped: no progress' end
     where b.state in ('queued', 'accepting', 'undoing')
       and (${lib}::uuid is null or b.library_id = ${lib}::uuid)
       and greatest(b.created_at, b.undo_requested_at,
                    (select max(greatest(i.accepted_at, i.undone_at)) from decider_batch_items i where i.batch_id = b.id))
           < now() - make_interval(secs => ${seconds}::int)
       and not exists (
             select 1 from pgboss.job j
              where j.name = 'decider.accept' and j.singleton_key = 'decider:' || b.id::text
                and j.state::text in ('created', 'retry', 'active'))
    returning b.id`;
  return rows.map((r) => r.id);
}
