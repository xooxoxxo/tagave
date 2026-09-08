import type { WorkerContext } from '../lib/context.js';

export interface FacetsRefreshJobData {
  /** one library, or every library when absent (the every-minute schedule) */
  libraryId?: string;
  /** rebuild even when nothing changed since the last build */
  force?: boolean;
}

/** A build older than this is redone even without a detected change (belt and braces). */
const MAX_AGE_MS = 10 * 60_000;

/**
 * XO-363: rebuilds album_facets for a library inside one transaction (readers
 * see the old rows or the new rows, never a mix). The row shapes mirror the
 * live facet queries in api/routes/albums.ts exactly — the API's smoke
 * compares the two — so keep them in step when a dimension changes.
 */
export async function facetsRefreshJob(ctx: WorkerContext, data: FacetsRefreshJobData): Promise<void> {
  const libraries = data.libraryId
    ? [data.libraryId]
    : ((await ctx.sql`select id from libraries`) as unknown as Array<{ id: string }>).map((r) => r.id);
  for (const libraryId of libraries) {
    const result = await refreshLibraryFacets(ctx, libraryId, data.force ?? false);
    if (result.skipped) ctx.logger.debug({ libraryId }, 'facets.refresh: up to date');
    else ctx.logger.info({ libraryId, albums: result.albums, ms: result.ms }, 'facets.refresh: rebuilt');
  }
}

export async function refreshLibraryFacets(
  ctx: WorkerContext,
  libraryId: string,
  force: boolean,
): Promise<{ skipped: boolean; albums?: number; ms?: number }> {
  const [st] = (await ctx.sql`
    select fs.computed_at, fs.dirty_at,
           (select max(updated_at) from local_albums where library_id = ${libraryId}) as albums_changed,
           (select greatest(max(first_seen_at), max(resolved_at)) from gaps where library_id = ${libraryId}) as gaps_changed,
           (select greatest(max(created_at), max(removed_at)) from collection_items where library_id = ${libraryId}) as collection_changed
    from (select 1) x
    left join facet_state fs on fs.library_id = ${libraryId}`) as unknown as Array<{
    computed_at: Date | null; dirty_at: Date | null;
    albums_changed: Date | null; gaps_changed: Date | null; collection_changed: Date | null;
  }>;
  const computedAt = st?.computed_at ?? null;
  const changed = [st?.dirty_at, st?.albums_changed, st?.gaps_changed, st?.collection_changed]
    .filter((d): d is Date => d instanceof Date);
  const stale = force || !computedAt
    || changed.some((d) => d.getTime() > computedAt.getTime())
    || Date.now() - computedAt.getTime() > MAX_AGE_MS;
  if (!stale) return { skipped: true };

  const started = Date.now();
  let albums = 0;
  await ctx.sql.begin(async (tx) => {
    await tx`delete from album_facets where library_id = ${libraryId}`;
    const inserted = await tx`
      insert into album_facets (album_id, library_id, release_group_id, state, format, containers, decade, labels, genres, gap_kinds, owned, decided)
      select la.id, la.library_id, la.release_group_id, la.state,
             case when f.has_lossless and not coalesce(f.has_lossy, false) then 'lossless'
                  when f.has_lossless then 'mixed'
                  else 'lossy' end,
             coalesce(la.formats, '{}'),
             -- tag garbage produces years like 1000 or 11289299; the rail lists 1900–2100 only
             case when la.year_guess between 1900 and 2100 then (la.year_guess / 10) * 10 end,
             coalesce(lb.labels, '{}'),
             coalesce(g.genres, '{}'),
             coalesce(gp.kinds, '{}'),
             exists (select 1 from collection_items ci where ci.release_group_id = la.release_group_id and ci.removed_at is null),
             array_remove(array[
               case when exists (select 1 from album_matches am where am.local_album_id = la.id and am.status in ('auto', 'confirmed')
                                   and am.decided_by = 'system' and am.reason like 'auto-accept:%') then 'auto_strong' end,
               case when exists (select 1 from album_matches am where am.local_album_id = la.id and am.status in ('auto', 'confirmed')
                                   and am.decided_by = 'system' and am.reason like 'chip-rule%') then 'chip_rule' end,
               case when exists (select 1 from album_matches am where am.local_album_id = la.id and am.status in ('auto', 'confirmed')
                                   and am.decided_by = 'system' and am.reason like 'first-candidate%') then 'first_candidate' end,
               case when exists (select 1 from album_matches am where am.local_album_id = la.id and am.status in ('auto', 'confirmed')
                                   and am.decided_by = 'user' and am.reason not like 'manual MBID%') then 'by_me' end,
               case when exists (select 1 from album_matches am where am.local_album_id = la.id and am.status in ('auto', 'confirmed')
                                   and am.reason like 'manual MBID%') then 'manual_mbid' end
             ]::text[], null)
      from local_albums la
      left join lateral (
        -- a track whose losslessness is unknown counts as lossy, as the format filter does
        select bool_or(af.lossless is true) as has_lossless, bool_or(not coalesce(af.lossless, false)) as has_lossy
        from local_tracks lt join audio_files af on af.id = lt.audio_file_id
        where lt.local_album_id = la.id) f on true
      left join lateral (
        select array_agg(l->>'name') as labels
        from releases r cross join lateral jsonb_array_elements(coalesce(r.labels, '[]'::jsonb)) l
        where r.id = la.release_id and l->>'name' is not null) lb on true
      left join lateral (
        select array_agg(distinct et.tag) as genres from entity_tags et
        where et.kind in ('genre', 'style') and et.entity_id in (la.release_group_id, la.release_id)) g on true
      left join lateral (
        select array_agg(distinct gg.kind) as kinds from gaps gg
        where gg.state = 'open' and gg.subject_id in (la.id, la.release_group_id)) gp on true
      where la.library_id = ${libraryId}
      returning 1`;
    albums = inserted.length;
    await tx`
      insert into facet_state (library_id, computed_at, album_count, duration_ms)
      values (${libraryId}, now(), ${albums}, ${Date.now() - started})
      on conflict (library_id) do update
        set computed_at = excluded.computed_at, album_count = excluded.album_count, duration_ms = excluded.duration_ms`;
  });
  return { skipped: false, albums, ms: Date.now() - started };
}
