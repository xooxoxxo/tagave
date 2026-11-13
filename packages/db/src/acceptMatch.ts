/**
 * One accept, inside the caller's transaction: lock the album row, check it
 * may still be decided, supersede its live match (the reason stays: it says
 * why that decision was made), insert the new decision with its provenance
 * and move the album to matched. It sends nothing: what follows an accept
 * (enrichment, track linking, cover, queue notice) is the caller's choice,
 * so a batch can leave it to the nightly sweeps.
 *
 * Locks, in this order: the album row (local_albums, for no key update, so
 * rows that only reference the album, such as its tracks or candidates, can
 * still be written), the release row (for key share, so it cannot be
 * deleted between the check and the insert that references it), then the
 * album's live match row (album_matches, for update). It never takes the
 * per-album evidence advisory lock: transactions that hold that lock take
 * it before anything else, and taking it here after the album row could
 * deadlock against them.
 */
import type postgres from 'postgres';

type Tx = postgres.TransactionSql<any>;
export type AcceptKind = 'user' | 'system' | 'rule' | 'model';
export interface AcceptInput {
  libraryId: string; albumId: string; releaseId: string; distance: number; source: string | null; reason: string;
  status: 'auto' | 'confirmed'; decidedBy: 'system' | 'user'; decidedKind: AcceptKind;
  decidedByUserId?: string | null; deciderId?: string | null; deciderVersion?: string | null;
  /** the decider's probability for the chosen release (0..1); required for a model accept */
  probability?: number | null; batchId?: string | null;
  /** accept only from these states; null = any state; default ['needs_review'] */
  fromStates?: string[] | null;
}
export interface PriorSnapshot {
  state: string; identifyReason: string | null; releaseId: string | null; releaseGroupId: string | null; identifiedAt: Date | null;
  liveMatchId: string | null; liveMatchStatus: string | null; liveMatchReason: string | null;
}
export type AcceptResult = { ok: true; matchId: string; prior: PriorSnapshot } | { ok: false; reason: 'gone' | 'state' | 'release_gone' };

/** Every model accept's reason starts with this, so no reader takes it for the owner's. */
export const MODEL_ACCEPT_REASON_PREFIX = 'model accept:';

/**
 * Checks an accept before anything touches the database: callers that want
 * to refuse a bad input before opening a transaction call it themselves;
 * acceptInTx calls it again first thing. A model's probability is what
 * readers show as its confidence, so a model accept without a usable one
 * is refused outright rather than stored as a gap readers would fill with
 * another number; and its reason must say it is the model's.
 */
export function assertAcceptInput(a: AcceptInput): void {
  const p = a.probability;
  if (p == null) {
    if (a.decidedKind === 'model') throw new RangeError('a model accept needs a probability between 0 and 1');
  } else if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`probability must be between 0 and 1, got ${p}`);
  }
  if (a.decidedKind === 'model' && !a.reason.startsWith(MODEL_ACCEPT_REASON_PREFIX)) {
    throw new RangeError(`a model accept's reason must start with "${MODEL_ACCEPT_REASON_PREFIX}"`);
  }
}

/** Lock the album row, check, supersede the live match (reason kept), insert the new one, move the album. No sends: downstream is the caller's. */
export async function acceptInTx(tx: Tx, a: AcceptInput): Promise<AcceptResult> {
  assertAcceptInput(a);
  const [album] = await tx<Array<{ state: string; identify_reason: string | null; release_id: string | null; release_group_id: string | null; identified_at: Date | string | null }>>`
    select state, identify_reason, release_id, release_group_id, identified_at
      from local_albums where id = ${a.albumId} and library_id = ${a.libraryId} for no key update`;
  if (!album) return { ok: false, reason: 'gone' };
  const from = a.fromStates === undefined ? ['needs_review'] : a.fromStates;
  if (from !== null && !from.includes(album.state)) return { ok: false, reason: 'state' };
  const [rel] = await tx<Array<{ release_group_id: string | null }>>`select release_group_id from releases where id = ${a.releaseId} for key share`;
  if (!rel) return { ok: false, reason: 'release_gone' };
  // At most one live match per album (a unique index holds it); the one
  // being replaced is read for the caller before it is superseded.
  const [live] = await tx<Array<{ id: string; status: string; reason: string | null }>>`
    select id, status, reason from album_matches
     where local_album_id = ${a.albumId} and status in ('auto', 'confirmed') for update`;
  if (live) {
    await tx`update album_matches set status = 'rejected'
              where local_album_id = ${a.albumId} and status in ('auto', 'confirmed')`;
  }
  const [m] = await tx<Array<{ id: string }>>`
    insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, reason, source,
                               decided_kind, decided_by_user_id, decider_id, decider_version, probability, batch_id)
    values (${a.libraryId}, ${a.albumId}, ${a.releaseId}, ${a.distance.toFixed(4)}, ${a.status}, ${a.decidedBy}, ${a.reason}, ${a.source},
            ${a.decidedKind}, ${a.decidedByUserId ?? null}, ${a.deciderId ?? null}, ${a.deciderVersion ?? null},
            ${a.probability == null ? null : a.probability.toFixed(4)}, ${a.batchId ?? null})
    returning id`;
  await tx`update local_albums
              set state = 'matched', release_id = ${a.releaseId}, release_group_id = ${rel.release_group_id},
                  identify_reason = null, identified_at = now(), updated_at = now()
            where id = ${a.albumId}`;
  return {
    ok: true, matchId: m!.id,
    prior: {
      state: album.state, identifyReason: album.identify_reason, releaseId: album.release_id, releaseGroupId: album.release_group_id,
      // the shared client may hand timestamptz back as text
      identifiedAt: album.identified_at == null ? null : new Date(album.identified_at),
      liveMatchId: live?.id ?? null, liveMatchStatus: live?.status ?? null, liveMatchReason: live?.reason ?? null,
    },
  };
}
