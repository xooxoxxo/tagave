/**
 * The albums one band of a finished decider run would accept as a batch:
 * the band's picks, minus the ones a spot check found wrong or unsure, minus
 * the ones already in an accepted or waiting item of a batch of this run,
 * minus the ones whose decision is not pinned to the evidence and identify
 * run it saw (a model batch item needs both). In the decisions' order.
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

export interface BandAcceptItem {
  albumId: string; releaseId: string; distance: number; source: string | null; probability: number | null;
  evidenceHash: string; lastIdentifyAt: string;
}

export interface BandAcceptPlan {
  items: BandAcceptItem[];
  /** picks a spot check found wrong or unsure */
  excludedWrong: number;
  /** picks already accepted, or waiting, in a batch of this run */
  alreadyAccepted: number;
  /** picks without the evidence hash or identify time their decision was made on */
  notPinned: number;
}

const iso = (t: Date | string): string => (t instanceof Date ? t : new Date(t)).toISOString();

export async function bandAcceptPlan(sql: Sql, runId: string, band: string): Promise<BandAcceptPlan> {
  const rows = await sql<Array<{
    album_id: string; release_id: string | null; distance: string | null; source: string | null; probability: string | null;
    evidence_hash: string | null; last_identify_at: Date | string | null; checked_bad: boolean; in_batch: boolean;
  }>>`
    select d.local_album_id::text as album_id, d.release_id::text as release_id, d.distance::text as distance, d.source,
           d.probability::text as probability, d.evidence_hash, d.last_identify_at,
           exists (select 1 from decider_spot_checks s where s.decision_id = d.id and s.verdict in ('wrong', 'unsure')) as checked_bad,
           exists (select 1 from decider_batch_items i join decider_batches b on b.id = i.batch_id
                    where b.run_id = d.run_id and b.decided_kind = 'model' and i.local_album_id = d.local_album_id
                      and i.status in ('pending', 'accepted')) as in_batch
      from decider_decisions d
     where d.run_id = ${runId} and d.outcome = 'pick' and d.band = ${band}
     order by d.created_at, d.id`;
  const plan: BandAcceptPlan = { items: [], excludedWrong: 0, alreadyAccepted: 0, notPinned: 0 };
  for (const r of rows) {
    if (r.checked_bad) { plan.excludedWrong += 1; continue; }
    if (r.in_batch) { plan.alreadyAccepted += 1; continue; }
    if (!r.release_id || !r.evidence_hash || r.last_identify_at === null || r.distance === null) { plan.notPinned += 1; continue; }
    plan.items.push({
      albumId: r.album_id, releaseId: r.release_id, distance: Number(r.distance), source: r.source,
      probability: r.probability === null ? null : Number(r.probability), evidenceHash: r.evidence_hash, lastIdentifyAt: iso(r.last_identify_at),
    });
  }
  return plan;
}
