import { sql as dsql } from 'drizzle-orm';
import { lintAlbum, type RawTrackTags } from '@liner/core';
import type { WorkerContext } from '../lib/context.js';
import { reportProgress } from './progress.js';

export interface GapsRecomputeJobData {
  libraryId: string;
}

/**
 * spec GAP-1/4/5. Recomputes gap rows set-based in SQL; the natural key
 * (library, kind, subject_type, subject_id) lets each run upsert while
 * dismissed rows keep their state. Gaps whose condition no longer holds are
 * marked resolved.
 */
export async function gapsRecomputeJob(ctx: WorkerContext, data: GapsRecomputeJobData): Promise<void> {
  const lib = data.libraryId;
  const started = Date.now();

  // --- GAP-1: incomplete albums (matched, fewer local tracks than canonical)
  await ctx.sql`
    insert into gaps (library_id, kind, subject_type, subject_id, details, state)
    select ${lib}, 'incomplete_album', 'local_album', la.id,
           jsonb_build_object(
             'have', la.track_count,
             'want', r.track_count,
             'missing', missing.tracks
           ),
           'open'
    from local_albums la
    join releases r on r.id = la.release_id
    join lateral (
      select jsonb_agg(jsonb_build_object(
               'disc', ct.medium_no, 'position', ct.position,
               'title', ct.title, 'lengthMs', ct.length_ms)
             order by ct.medium_no, ct.position) as tracks
      from canonical_tracks ct
      where ct.release_id = r.id
        and not ct.is_data_track and not ct.is_video
        and not exists (
          select 1 from local_tracks lt
          where lt.local_album_id = la.id
            and coalesce(lt.disc_no, 1) = coalesce(ct.medium_no, 1)
            and lt.track_no = ct.position)
    ) missing on true
    where la.library_id = ${lib}
      and la.state = 'matched'
      and r.track_count is not null
      and la.track_count < r.track_count
    on conflict (library_id, kind, subject_type, subject_id)
    do update set details = excluded.details,
                  state = case when gaps.state = 'dismissed' then 'dismissed' else 'open' end,
                  resolved_at = null`;

  // resolve incomplete gaps that no longer hold
  await ctx.sql`
    update gaps g set state = 'resolved', resolved_at = now()
    where g.library_id = ${lib} and g.kind = 'incomplete_album' and g.state != 'resolved'
      and not exists (
        select 1 from local_albums la
        join releases r on r.id = la.release_id
        where la.id = g.subject_id and la.state = 'matched'
          and r.track_count is not null and la.track_count < r.track_count)`;

  // --- GAP-4: duplicates (several local albums on one release group)
  await ctx.sql`
    insert into gaps (library_id, kind, subject_type, subject_id, details, state)
    select ${lib}, 'duplicate', 'release_group', d.release_group_id,
           jsonb_build_object('albumIds', d.ids, 'count', d.n), 'open'
    from (
      select release_group_id, count(*) as n, jsonb_agg(id) as ids
      from local_albums
      where library_id = ${lib} and release_group_id is not null and state != 'ignored'
      group by release_group_id having count(*) > 1
    ) d
    on conflict (library_id, kind, subject_type, subject_id)
    do update set details = excluded.details,
                  state = case when gaps.state = 'dismissed' then 'dismissed' else 'open' end,
                  resolved_at = null`;
  await ctx.sql`
    update gaps g set state = 'resolved', resolved_at = now()
    where g.library_id = ${lib} and g.kind = 'duplicate' and g.state != 'resolved'
      and (select count(*) from local_albums la
           where la.library_id = ${lib} and la.release_group_id = g.subject_id
             and la.state != 'ignored') < 2`;

  // --- GAP-2: missing albums per followed artist (release groups not owned locally)
  // Mark-and-sweep: pre-mark every live missing_album row, let the upsert clear
  // the mark on rows still missing, then resolve whatever stayed marked.

  // Pre-mark all missing_album rows with resolved_at
  await ctx.sql`
    update gaps set resolved_at = now()
    where library_id = ${lib} and kind = 'missing_album' and state != 'resolved'`;

  // Fetch all release groups for followed artists and insert/upsert missing_album gaps
  await ctx.sql`
    insert into gaps (library_id, kind, subject_type, subject_id, details, state)
    select ${lib}, 'missing_album', 'release_group', rga.release_group_id,
           jsonb_build_object('title', rg.title, 'primaryType', rg.primary_type),
           'open'
    from followed_artists fa
    join release_group_artists rga on rga.artist_id = fa.artist_id
    join release_groups rg on rg.id = rga.release_group_id
    where fa.library_id = ${lib}
      and not exists (
        select 1 from local_albums la
        where la.library_id = ${lib}
          and la.release_group_id = rga.release_group_id
          and la.state != 'ignored')
    on conflict (library_id, kind, subject_type, subject_id)
    do update set details = excluded.details,
                  state = case when gaps.state = 'dismissed' then 'dismissed' else 'open' end,
                  resolved_at = null`;

  // Resolve missing_album gaps that no longer hold (release group is now owned)
  await ctx.sql`
    update gaps g set state = 'resolved', resolved_at = now()
    where g.library_id = ${lib} and g.kind = 'missing_album' and g.state != 'resolved'
      and resolved_at is not null`;

  // --- GAP-5: quality flags per album, one row per (album, flag) family in details
  // Mark-and-sweep: pre-mark every live quality row, let the upsert clear the
  // mark on rows still flagged, then resolve whatever stayed marked. (A
  // condition-recheck here would have to mirror every flag; a stale mirror
  // wrongly resolved lowBitrate-only rows on the first run.)

  // Fetch library settings to get lint rule toggles
  const libSettings = await ctx.sql`
    select settings from libraries where id = ${lib}` as unknown as Array<{ settings: string | null }>;

  const settingsObj = libSettings?.[0]?.settings
    ? (typeof libSettings[0].settings === 'string' ? JSON.parse(libSettings[0].settings) : libSettings[0].settings)
    : {};
  const lintRulesToggle = (settingsObj as Record<string, any>)['lintRules'] ?? {
    inconsistentAlbumFields: true,
    missingMbIds: true,
    trackNumberIssues: true,
    titleCaseAnomalies: true,
    emptyRequiredFields: true,
    discNumberGaps: true,
    noEmbeddedArt: true,
  };

  await ctx.sql`
    update gaps set resolved_at = now()
    where library_id = ${lib} and kind = 'quality' and state != 'resolved'`;

  // Fetch all albums and their audio quality info for this library
  const albumQualityRows = await ctx.sql`
    select la.id,
           jsonb_strip_nulls(jsonb_build_object(
             'noCover', case when i.id is null then true else null end,
             'parseErrors', nullif(err.n, 0),
             'mixedLossless', case when losslessness.kinds = 2 then true else null end,
             'lowBitrate', nullif(lowbr.n, 0)
           )) as audio_flags,
           i.id is not null as has_embedded_art
    from local_albums la
    left join images i on i.local_album_id = la.id and i.kind = 'front'
    join lateral (
      select count(*) filter (where af.status = 'error') as n
      from local_tracks lt join audio_files af on af.id = lt.audio_file_id
      where lt.local_album_id = la.id) err on true
    join lateral (
      select count(distinct af.lossless) as kinds
      from local_tracks lt join audio_files af on af.id = lt.audio_file_id
      where lt.local_album_id = la.id and af.lossless is not null) losslessness on true
    join lateral (
      select count(*) filter (where af.lossless = false and af.bitrate_kbps < 192) as n
      from local_tracks lt join audio_files af on af.id = lt.audio_file_id
      where lt.local_album_id = la.id) lowbr on true
    where la.library_id = ${lib} and la.state not in ('ignored')
  ` as unknown as Array<{ id: string; audio_flags: Record<string, unknown>; has_embedded_art: boolean }>;

  // For each album, fetch tracks and compute lint flags
  for (const row of albumQualityRows) {
    const albumId = row.id;
    const audioFlags = row.audio_flags || {};

    // Fetch tracks with their tags_raw for this album
    const trackRows = await ctx.sql`
      select af.tags_raw
      from local_tracks lt
      join audio_files af on af.id = lt.audio_file_id
      where lt.local_album_id = ${albumId}
      order by coalesce(lt.disc_no, 1), coalesce(lt.track_no, 0)
    ` as unknown as Array<{ tags_raw: Record<string, unknown> | null }>;

    // Compute lint flags if we have tracks
    let tagFlagsObj: Record<string, unknown> = {};
    if (trackRows.length > 0) {
      const rawTracks: RawTrackTags[] = trackRows
        .map((tr) => (tr.tags_raw ?? {}) as RawTrackTags)
        .filter((t) => Object.keys(t).length > 0);

      if (rawTracks.length > 0) {
        const lintFlags = lintAlbum(rawTracks, lintRulesToggle, row.has_embedded_art);
        // Convert lint flags to object: { ruleName: details || true }
        for (const flag of lintFlags) {
          tagFlagsObj[flag.rule] = flag.details ?? true;
        }
      }
    }

    // Merge audio flags and tag flags
    const allFlags = { ...audioFlags, ...tagFlagsObj };

    // Only insert if there are flags
    if (Object.keys(allFlags).length > 0) {
      const flagsJson = JSON.stringify(allFlags);
      await ctx.sql`
        insert into gaps (library_id, kind, subject_type, subject_id, details, state)
        values (${lib}, 'quality', 'local_album', ${albumId}, jsonb_build_object('flags', ${flagsJson}::jsonb), 'open')
        on conflict (library_id, kind, subject_type, subject_id)
        do update set details = excluded.details,
                      state = case when gaps.state = 'dismissed' then 'dismissed' else 'open' end,
                      resolved_at = null`;
    }
  }

  await ctx.sql`
    update gaps set state = 'resolved'
    where library_id = ${lib} and kind = 'quality' and state != 'resolved'
      and resolved_at is not null`;

  const counts = await ctx.sql`
    select kind, count(*) filter (where state = 'open') as open
    from gaps where library_id = ${lib} group by kind` as unknown as { kind: string; open: string }[];

  await reportProgress(ctx, null, {
    libraryId: lib,
    type: 'gaps.recompute',
    state: 'completed',
    message: counts.map((c) => `${c.kind}:${c.open}`).join(' '),
  });
  ctx.logger.info({ libraryId: lib, counts, elapsedMs: Date.now() - started }, 'gaps recomputed');
}
