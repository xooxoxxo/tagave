/**
 * The gap-fill ledger (0050, identity_fills; Module Composition Principle
 * rule 3): when a module fills a missing core fact (an album's MBID), the
 * ledger records which module and link did, so the fill can be listed and
 * reverted on unplug. A value a person set or confirmed is never changed and
 * never reverted.
 *
 * A fill counts as confirmed once:
 *   - a person ticked "Keep" (confirmFill: confirmed_at), or
 *   - a person decided the match of an album of that release group after the
 *     fill (album_matches.decided_by = 'user'), or
 *   - a person locked an MBID field of such an album after the fill
 *     (field_locks).
 *
 * Every fill and revert is in the audit log, under the module's name.
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

export interface FillRef {
  module: string;
  /** the link or account that brought the value (mc: the link id) */
  sourceRef: string | null;
  /** who the audit entry names (the link's person) */
  actorUserId: string | null;
}

/**
 * Fill release_groups.mbid when it is empty and no other release group
 * holds the value. Returns 'filled', or why not: 'not_empty' (it has an MBID
 * now), 'in_use' (another group has it), 'gone'.
 */
export async function fillAlbumMbid(sql: Sql, releaseGroupId: string, mbid: string, ref: FillRef): Promise<'filled' | 'not_empty' | 'in_use' | 'gone'> {
  const value = mbid.toLowerCase();
  const run = async (tx: Sql) => {
    const [rg] = await tx<Array<{ mbid: string | null }>>`select mbid from release_groups where id = ${releaseGroupId} for update`;
    if (!rg) return 'gone' as const;
    if (rg.mbid !== null) return 'not_empty' as const;
    const [holder] = await tx`select 1 from release_groups where lower(mbid) = ${value} and id <> ${releaseGroupId} limit 1`;
    if (holder) return 'in_use' as const;
    await tx`update release_groups set mbid = ${value} where id = ${releaseGroupId} and mbid is null`;
    await tx`
      insert into identity_fills (kind, entity_id, field, value, module, source_ref)
      values ('album', ${releaseGroupId}, 'mbid', ${value}, ${ref.module}, ${ref.sourceRef})
      on conflict (kind, entity_id, field) do update
        set value = excluded.value, module = excluded.module, source_ref = excluded.source_ref,
            created_at = now(), confirmed_at = null, confirmed_by = null`;
    await tx`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id, payload)
             values (null, ${ref.actorUserId}, 'identity.fill', 'release_group', ${releaseGroupId},
                     ${JSON.stringify({ field: 'mbid', value, module: ref.module, source_ref: ref.sourceRef })}::text::jsonb)`;
    return 'filled' as const;
  };
  try {
    // a savepoint inside a caller's transaction, a transaction of its own otherwise
    if ('savepoint' in sql) return await (sql as postgres.TransactionSql<any>).savepoint((tx) => run(tx));
    return await (sql as postgres.Sql<any>).begin((tx) => run(tx));
  } catch (e) {
    // the unique index on release_groups.mbid: a writer took it meanwhile
    if ((e as { code?: string }).code === '23505') return 'in_use';
    throw e;
  }
}

/** Whether a person has confirmed this fill (see the header). SQL over `f` (an identity_fills row). */
const CONFIRMED = (sql: Sql) => sql`(
  f.confirmed_at is not null
  or exists (select 1 from album_matches m join local_albums la on la.id = m.local_album_id
              where la.release_group_id = f.entity_id and m.decided_by = 'user' and m.decided_at >= f.created_at)
  or exists (select 1 from field_locks fl join local_albums la on la.id = fl.scope_id
              where fl.scope = 'album' and la.release_group_id = f.entity_id and fl.created_at >= f.created_at
                and (fl.field ilike '%mbid%' or fl.field ilike '%musicbrainz%'))
)`;

/** A person keeps a fill: it is theirs now, and no revert touches it. */
export async function confirmFill(sql: Sql, fillId: string, userId: string | null): Promise<void> {
  await sql`update identity_fills set confirmed_at = coalesce(confirmed_at, now()), confirmed_by = coalesce(confirmed_by, ${userId}) where id = ${fillId}`;
}

/** Keep every fill a module (or one of its links) made. */
export async function confirmFills(sql: Sql, module: string, sourceRef: string | null, userId: string | null): Promise<number> {
  const rows = await sql`
    update identity_fills set confirmed_at = coalesce(confirmed_at, now()), confirmed_by = coalesce(confirmed_by, ${userId})
     where module = ${module} and (${sourceRef}::uuid is null or source_ref = ${sourceRef}::uuid)
    returning id`;
  return rows.length;
}

export interface RevertResult {
  /** fields set back to empty */
  reverted: number;
  /** confirmed by a person, or changed since: left as they are */
  kept: number;
}

/**
 * Revert the fills of a module, or of one of its links (sourceRef), or of
 * one release group (entityId): each field goes back to empty, but only when
 * the fill is unconfirmed and the field still holds the filled value. Every
 * ledger row of the scope is removed either way: a kept value is core's own
 * from then on.
 */
export async function revertFills(sql: Sql, scope: { module: string; sourceRef?: string | null; entityId?: string }, actorUserId: string | null = null): Promise<RevertResult> {
  const ref = scope.sourceRef ?? null;
  const entity = scope.entityId ?? null;
  const fills = await sql<Array<{ id: string; entity_id: string; value: string; confirmed: boolean }>>`
    select f.id, f.entity_id, f.value, ${CONFIRMED(sql)} as confirmed
      from identity_fills f
     where f.module = ${scope.module}
       and (${ref}::uuid is null or f.source_ref = ${ref}::uuid)
       and (${entity}::uuid is null or f.entity_id = ${entity}::uuid)
     for update of f`;
  let reverted = 0;
  let kept = 0;
  for (const f of fills) {
    const done = f.confirmed ? [] : await sql`
      update release_groups set mbid = null
       where id = ${f.entity_id} and mbid = ${f.value}
         -- the group keeps an identity of its own (release_groups_identity)
         and (discogs_master_id is not null or discogs_release_id is not null)
      returning id`;
    if (done.length > 0) reverted++;
    else kept++;
    await sql`delete from identity_fills where id = ${f.id}`;
    await sql`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id, payload)
              values (null, ${actorUserId}, ${done.length > 0 ? 'identity.fill_reverted' : 'identity.fill_kept'}, 'release_group', ${f.entity_id},
                      ${JSON.stringify({ field: 'mbid', value: f.value, module: scope.module, source_ref: ref })}::text::jsonb)`;
  }
  return { reverted, kept };
}

/**
 * The release groups whose MBID is an unconfirmed fill: their identity goes
 * out as provenance 'auto' (the echo rule: a value filled from a source is
 * never served back as stronger evidence than that source gave).
 */
export async function unconfirmedFilledGroups(sql: Sql, releaseGroupIds: string[]): Promise<Set<string>> {
  if (releaseGroupIds.length === 0) return new Set();
  const rows = await sql<Array<{ entity_id: string }>>`
    select f.entity_id::text as entity_id from identity_fills f
      join release_groups rg on rg.id = f.entity_id and rg.mbid = f.value
     where f.kind = 'album' and f.field = 'mbid' and f.entity_id = any(${releaseGroupIds}::uuid[]) and not ${CONFIRMED(sql)}`;
  return new Set(rows.map((r) => r.entity_id));
}
