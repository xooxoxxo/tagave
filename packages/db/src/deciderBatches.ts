/**
 * Accept batches (0071): one decider_batches row per set of albums accepted
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
 * the caller is in one). Items go in with one set-based insert, in input
 * order: each item's created_at is the statement's time plus its position in
 * microseconds, so reading by (created_at, id) gives them back in that order.
 * The same album twice in one batch is refused (unique), and nothing is kept.
 */
export async function createBatch(sql: Sql, input: CreateBatchInput): Promise<string> {
  const items = input.items;
  const run = async (tx: Sql): Promise<string> => {
    const [b] = await tx<Array<{ id: string }>>`
      insert into decider_batches (library_id, decider_id, decider_version, decided_kind, run_id, band, accept_from, started_by_user_id)
      values (${input.libraryId}, ${input.deciderId}, ${input.deciderVersion}, ${input.decidedKind}, ${input.runId ?? null},
              ${input.band ?? null}, ${input.acceptFrom ?? ['needs_review']}::text[], ${input.startedByUserId})
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
                                       evidence_hash, expect_last_identify_at, reason, created_at)
      select ${batchId}, u.album, u.rel, u.dist, u.src, u.prob, u.hash, u.expect, u.reason,
             now() + u.ord * interval '1 microsecond'
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
           started_by_user_id, created_at, accepted_at, undone_at
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
  };
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

/** Up to `limit` items of a batch with this status, in the order they were added. */
export async function itemsWithStatus(sql: Sql, batchId: string, status: ItemStatus, limit: number): Promise<BatchItemRow[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    select id, batch_id, local_album_id, release_id, distance, source, probability, evidence_hash,
           expect_last_identify_at, reason, status, skip_reason, match_id, prior_state, prior_identify_reason,
           prior_release_id, prior_release_group_id, prior_identified_at, prior_match_id, prior_match_status,
           prior_match_reason, accepted_at, undone_at
      from decider_batch_items
     where batch_id = ${batchId} and status = ${status}
     order by created_at, id
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

/** Items per status, and the skipped and left items per reason. */
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
    if (by) { const key = r.skip_reason ?? 'unknown'; by[key] = (by[key] ?? 0) + r.n; }
  }
  return out;
}
