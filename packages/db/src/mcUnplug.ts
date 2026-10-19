/**
 * Plugging Music Connections out (Facets and Connectors design §8; Module
 * Composition Principle rule 2): what revoking a link, and removing the
 * module, do to the data.
 *
 *   revoke a link    in one transaction: delete that link's rows in every
 *                    module table, revert its unconfirmed gap fills and
 *                    delete its undecided identify-queue candidates
 *                    (match_candidates.source = 'mc:<link>'). What a person
 *                    decided stays: accepted wantlist entries (wantlist_items)
 *                    and confirmed matches.
 *   remove the data  every link as above, then the module's remaining rows
 *                    (links, authorizations in flight, the provider's
 *                    clients and tokens). "Keep" first confirms the fills.
 *   turn off         nothing here: jobs skip, the UI hides, the data stays.
 *
 * Revoking at the remote is the caller's (it needs the link's tokens).
 */
import type postgres from 'postgres';
import { confirmFills, revertFills } from './identityFills.js';
import { identifyWithdraw } from './identifyQueue.js';

type Sql = postgres.Sql<any>;
type Tx = postgres.TransactionSql<any>;

/** The module tables a link's rows live in (worker › jobs/mcLanding.ts writes them). */
export const MC_LINK_TABLES = ['mc_critic_scores', 'mc_identity', 'mc_wantlist_suggestions'] as const;

/** match_candidates.source of a link's suggestions. */
export const mcCandidateSource = (linkId: string): string => `mc:${linkId}`;

export interface UnplugCounts {
  rows: number;
  candidates: number;
  fillsReverted: number;
  fillsKept: number;
}

/** A link's landed data, inside the caller's transaction. */
export async function unplugLinkTx(tx: Tx, linkId: string, actorUserId: string | null): Promise<UnplugCounts> {
  const fills = await revertFills(tx, { module: 'mc', sourceRef: linkId }, actorUserId);
  // undecided only: a candidate a person accepted or excluded is theirs
  const candidates = await identifyWithdraw(tx, { exact: mcCandidateSource(linkId) });
  let rows = 0;
  for (const t of MC_LINK_TABLES) rows += (await tx`delete from ${tx(t)} where link_id = ${linkId} returning id`).length;
  await tx`update mc_links set snapshot_since = '{}'::jsonb where id = ${linkId}`;
  return { rows, candidates, fillsReverted: fills.reverted, fillsKept: fills.kept };
}

export async function unplugLink(sql: Sql, linkId: string, actorUserId: string | null): Promise<UnplugCounts> {
  return sql.begin((tx) => unplugLinkTx(tx, linkId, actorUserId));
}

/**
 * Remove Music Connections' data: every link unplugged, then the links, the
 * authorizations in flight and the provider's clients and tokens. With
 * keepFills the MBIDs it filled are confirmed first and stay.
 */
export async function removeMcData(sql: Sql, opts: { keepFills: boolean; actorUserId: string | null }): Promise<UnplugCounts & { links: number }> {
  return sql.begin(async (tx) => {
    // Links first, as revoke does (the pull transaction holds a link's row,
    // then its fills): confirming the fills first would take the locks in the
    // opposite order and could deadlock with an in-flight page's revertFills.
    const links = await tx<Array<{ id: string }>>`select id from mc_links for update`;
    if (opts.keepFills) await confirmFills(tx, 'mc', null, opts.actorUserId);
    const total: UnplugCounts = { rows: 0, candidates: 0, fillsReverted: 0, fillsKept: 0 };
    for (const l of links) {
      const c = await unplugLinkTx(tx, l.id, opts.actorUserId);
      total.rows += c.rows;
      total.candidates += c.candidates;
      total.fillsReverted += c.fillsReverted;
      total.fillsKept += c.fillsKept;
    }
    // fills whose link is gone already
    const rest = await revertFills(tx, { module: 'mc' }, opts.actorUserId);
    total.fillsReverted += rest.reverted;
    total.fillsKept += rest.kept;
    total.candidates += await identifyWithdraw(tx, { prefix: 'mc:' });
    await tx`delete from mc_links`;
    await tx`delete from mc_pending`;
    await tx`delete from mc_oauth_tokens`;
    await tx`delete from mc_oauth_requests`;
    await tx`delete from mc_oauth_clients`;
    return { ...total, links: links.length };
  });
}

// ── The module switch (Settings › Modules) ─────────────────────────────────
// Kept in the settings of the install's first library (the one the feeds
// and links read): settings.modules.mc.enabled. Absent means off, as for the
// player: a new or updated install links nothing until the owner turns it on.
// Read per call (each request, each job run), so the switch needs no restart.

export async function mcEnabled(sql: Sql | Tx): Promise<boolean> {
  const [row] = await sql<Array<{ v: string | null }>>`
    select settings->'modules'->'mc'->>'enabled' as v from libraries order by created_at, id limit 1`;
  return row?.v === 'true';
}

export async function setMcEnabled(sql: Sql | Tx, enabled: boolean): Promise<void> {
  await sql`
    update libraries set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{modules}',
           coalesce(settings->'modules', '{}'::jsonb) || jsonb_build_object('mc', coalesce(settings->'modules'->'mc', '{}'::jsonb) || jsonb_build_object('enabled', ${enabled}::boolean)))
     where id = (select id from libraries order by created_at, id limit 1)`;
}
