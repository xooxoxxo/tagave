import { sql as dsql } from 'drizzle-orm';
import { lintAlbum } from '@tagave/core';
import { rawTracksForLint } from '../lib/canonicalTags.js';
import type { WorkerContext } from '../lib/context.js';
import { recomputeMissingAlbumGaps } from '../lib/missingAlbumGaps.js';
import { keepDecisionOnConflict } from '../lib/gapUpsert.js';
import { reportProgress } from './progress.js';
import { albumLiveSql, recomputeAlbumGaps } from '@tagave/db';

export interface GapsRecomputeJobData {
  libraryId: string;
  /**
   * Only these albums: the ones an operation touched (a tag plan, a move, a
   * merge, a rescan …). Their album-level gaps and quality flags are
   * recomputed; the library-wide missing-albums pass is left to the nightly
   * unscoped run.
   */
  albumIds?: string[];
  /**
   * Only the album-level gaps (incomplete, duplicate, one file, gone), for
   * the whole library: the worker's boot sweep (rr85). Cheap SQL that puts
   * right what an operation left stale before albums changed rechecked their
   * gaps, without waiting for the nightly run.
   */
  albumGapsOnly?: boolean;
}

/**
 * spec GAP-1/4/5. Recomputes gap rows set-based in SQL; the natural key
 * (library, kind, subject_type, subject_id, flag) lets each run upsert while
 * dismissed rows and tasks keep their state (keepDecisionOnConflict). Gaps
 * whose condition no longer holds are marked resolved — a task included: it
 * keeps accepted_at, so the Tasks list shows it crossed out as done.
 */
export async function gapsRecomputeJob(ctx: WorkerContext, data: GapsRecomputeJobData): Promise<void> {
  const lib = data.libraryId;
  const started = Date.now();

  const scoped = data.albumIds !== undefined;
  const albumScope = data.albumIds ?? [];

  // --- GAP-1/4 and whole album in one file (0078): incomplete albums,
  // duplicates, one-file albums, and the gaps of albums that are gone. One
  // definition shared with the api, which runs it for the albums an
  // operation touched in the same request (@tagave/db › recomputeAlbumGaps).
  await recomputeAlbumGaps(ctx.sql, lib, scoped ? albumScope : null);
  if (data.albumGapsOnly && !scoped) {
    await reportProgress(ctx, null, { libraryId: lib, type: 'gaps.recompute', state: 'completed', message: 'album gaps rechecked' });
    ctx.logger.info({ libraryId: lib, elapsedMs: Date.now() - started }, 'album gaps rechecked');
    return;
  }

  // --- GAP-2: missing albums per followed artist (release groups not owned
  // locally, filtered by the artist's follow rules). Shared with artist.refresh,
  // which runs the same pass scoped to the refreshed artist.
  if (!scoped) await recomputeMissingAlbumGaps(ctx, lib);

  // --- GAP-5: quality flags per album, one row per (album, flag) (0032), so
  // each flag can be hidden or taken on as a task on its own
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
    where library_id = ${lib} and kind = 'quality' and state != 'resolved'
      and (${!scoped} or subject_id = any(${albumScope}::uuid[]))`;

  // Fetch all albums and their audio quality info for this library
  const albumQualityRows = await ctx.sql`
    select la.id,
           jsonb_strip_nulls(jsonb_build_object(
             'noCover', case when i.id is null then true else null end,
             'parseErrors', nullif(err.n, 0),
             'mixedLossless', case when losslessness.kinds = 2 then true else null end,
             'lowBitrate', nullif(lowbr.n, 0),
             -- a folder of files without album tags, titled after the folder
             -- (cluster.dir; QA 2026-10-26 Q-05)
             'noAlbumTags', case when notags.n > 0 and notags.tagged = 0 then true else null end
           )) as audio_flags,
           -- the files' own pictures (scan.parse), not the stored front cover:
           -- an album with art in its files but no cover fetched yet is not
           -- "No embedded art" (QA 2026-10-26 Q-19)
           exists (
             select 1 from local_tracks lt join files af on af.id = lt.audio_file_id
              where lt.local_album_id = la.id and af.has_embedded_art) as has_embedded_art
    from local_albums la
    left join images i on i.local_album_id = la.id and i.kind = 'front'
    join lateral (
      select count(*) filter (where af.status = 'error') as n
      from local_tracks lt join files af on af.id = lt.audio_file_id
      where lt.local_album_id = la.id) err on true
    join lateral (
      select count(distinct af.lossless) as kinds
      from local_tracks lt join files af on af.id = lt.audio_file_id
      where lt.local_album_id = la.id and af.lossless is not null) losslessness on true
    join lateral (
      select count(*) filter (where af.lossless = false and af.bitrate_kbps < 192) as n
      from local_tracks lt join files af on af.id = lt.audio_file_id
      where lt.local_album_id = la.id) lowbr on true
    join lateral (
      select count(*) as n,
             count(*) filter (where lt.origin = 'cue'
                                 or nullif(btrim(af.tags_raw->'common'->>'album'), '') is not null) as tagged
      from local_tracks lt join files af on af.id = lt.audio_file_id
      where lt.local_album_id = la.id) notags on true
    where la.library_id = ${lib} and la.state not in ('ignored')
      and (${!scoped} or la.id = any(${albumScope}::uuid[]))
      and ${ctx.sql.unsafe(albumLiveSql('la.id'))}
  ` as unknown as Array<{ id: string; audio_flags: Record<string, unknown>; has_embedded_art: boolean }>;

  // For each album, fetch tracks and compute lint flags
  for (const row of albumQualityRows) {
    const albumId = row.id;
    const audioFlags = row.audio_flags || {};

    // Fetch tracks with their tags_raw for this album
    const trackRows = await ctx.sql`
      select af.tags_raw
      from local_tracks lt
      join files af on af.id = lt.audio_file_id
      where lt.local_album_id = ${albumId}
      order by coalesce(lt.disc_no, 1), coalesce(lt.track_no, 0)
    ` as unknown as Array<{ tags_raw: Record<string, unknown> | null }>;

    // Compute lint flags if we have tracks
    let tagFlagsObj: Record<string, unknown> = {};
    if (trackRows.length > 0) {
      const rawTracks = rawTracksForLint(trackRows.map((tr) => tr.tags_raw ?? {}))
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
        insert into gaps (library_id, kind, subject_type, subject_id, details, state, flag)
        select ${lib}, 'quality', 'local_album', ${albumId},
               jsonb_build_object('flags', jsonb_build_object(f.key, f.value)), 'open', f.key
          from jsonb_each(${flagsJson}::jsonb) f
        ${keepDecisionOnConflict(ctx.sql)}`;
    }
  }

  await ctx.sql`
    update gaps set state = 'resolved'
    where library_id = ${lib} and kind = 'quality' and state != 'resolved'
      and resolved_at is not null
      and (${!scoped} or subject_id = any(${albumScope}::uuid[]))`;

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
