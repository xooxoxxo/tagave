/**
 * GAP-2 missing albums: one gap per release group of a followed artist that
 * the library owns no local album for and that the artist's follow rules
 * include (primary type listed, no excluded secondary type; null per-artist
 * columns inherit the library rules).
 *
 * Mark-and-sweep on the natural key (library, kind, subject_type, subject_id):
 * pre-mark every live row, let the upsert clear the mark on rows still
 * missing, resolve whatever stayed marked. Dismissed rows keep their state.
 *
 * `artistId` scopes the pass to release groups linked to one artist — the
 * artist.refresh job runs it so the artist page and the Attention list show
 * the refresh at once; the nightly gaps.recompute runs it unscoped. In scoped
 * mode every followed artist on those groups still counts, so a group shared
 * with another followed artist is judged by both rule sets.
 */
import type { WorkerContext } from './context.js';
import { loadLibraryFollowRules } from './followRules.js';

export async function recomputeMissingAlbumGaps(
  ctx: WorkerContext,
  libraryId: string,
  opts: { artistId?: string } = {},
): Promise<void> {
  const library = await loadLibraryFollowRules(ctx, libraryId);
  const includePrimary = library.includePrimary as string[];
  const excludeSecondary = library.excludeSecondary as string[];
  const sql = ctx.sql;

  const gapScope = opts.artistId
    ? sql`and exists (select 1 from release_group_artists s
                       where s.release_group_id = gaps.subject_id and s.artist_id = ${opts.artistId})`
    : sql``;
  const groupScope = opts.artistId
    ? sql`and exists (select 1 from release_group_artists s
                       where s.release_group_id = rga.release_group_id and s.artist_id = ${opts.artistId})`
    : sql``;

  await sql`
    update gaps set resolved_at = now()
    where library_id = ${libraryId} and kind = 'missing_album' and state != 'resolved' ${gapScope}`;

  // distinct on: a group shared by two followed artists must reach the
  // upsert once ("ON CONFLICT DO UPDATE command cannot affect row a second time").
  await sql`
    insert into gaps (library_id, kind, subject_type, subject_id, details, state)
    select distinct on (rga.release_group_id)
           ${libraryId}, 'missing_album', 'release_group', rga.release_group_id,
           jsonb_build_object('title', rg.title, 'primaryType', rg.primary_type),
           'open'
      from followed_artists fa
      join release_group_artists rga on rga.artist_id = fa.artist_id
      join release_groups rg on rg.id = rga.release_group_id
     where fa.library_id = ${libraryId}
       ${groupScope}
       and rg.primary_type = any(coalesce(fa.include_primary, ${includePrimary}::text[]))
       and not (coalesce(rg.secondary_types, '{}'::text[]) && coalesce(fa.exclude_secondary, ${excludeSecondary}::text[]))
       and not exists (
         select 1 from local_albums la
          where la.library_id = ${libraryId}
            and la.release_group_id = rga.release_group_id
            and la.state != 'ignored')
     order by rga.release_group_id
    on conflict (library_id, kind, subject_type, subject_id)
    do update set details = excluded.details,
                  state = case when gaps.state = 'dismissed' then 'dismissed' else 'open' end,
                  resolved_at = null`;

  await sql`
    update gaps set state = 'resolved', resolved_at = now()
    where library_id = ${libraryId} and kind = 'missing_album' and state != 'resolved'
      and resolved_at is not null ${gapScope}`;
}
