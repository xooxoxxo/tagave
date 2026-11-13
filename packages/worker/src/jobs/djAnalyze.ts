/**
 * dj.analyze: a track's tempo, first beat, trim points and waveform peaks
 * (the dj module; core › dj/analysis.ts).
 *
 *   { localTrackId }  one track: the sweep's, or one the player asked for
 *                     (the next tracks of a queue; api › routes/dj.ts)
 *   { sweep: true }   the next SWEEP_BATCH tracks that need it, each sent as
 *                     its own job, then the next sweep behind them
 *
 * Gentle on purpose: on the file worker (it reads the music folder), one
 * job at a time (batchSize 1), ffmpeg at nice 15, the sweep's tracks at a
 * lower priority than the player's. Order of the sweep: tracks in someone's
 * play queue (from where they are), then tracks played in the last 30 days,
 * then the rest album by album.
 *
 * A track needs it when it has no row, or its file's size or mtime changed
 * since (a failed one after a week too). A changed file is hashed first
 * (its audio packets, no decode): the same audio keeps its row (a re-tag),
 * another track with that audio lends its row (a copy), only new audio is
 * decoded. Skips when the module is off (Settings › Modules).
 */
import path from 'node:path';
import { djEnabled, recordDjError, saveDjAnalysis } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { djAudioHash, djDecodeAndAnalyze, type DjWindow } from '../lib/djDecode.js';

export interface DjAnalyzeJobData {
  localTrackId?: string;
  sweep?: boolean;
  /** decode again even when the row is current */
  force?: boolean;
}

export const SWEEP_BATCH = 25;
/** pg-boss runs the higher first: what the player asks for, then the sweep's tracks, then the next sweep. */
export const DJ_PRIORITY = { asked: 10, swept: 1, sweep: 0 } as const;
const FAILED_RETRY = '7 days';
const RECENT_PLAYS = '30 days';

type Outcome = 'analyzed' | 'rehashed' | 'copied' | 'current' | 'failed' | 'gone';
type Result = { skipped: string } | { outcome: Outcome } | { queued: number; more: boolean };

interface TrackRow {
  id: string;
  rel_path: string;
  root_path: string;
  status: string;
  size_bytes: number | null;
  mtime: number | null;
  origin: string;
  cue_start_ms: number | null;
  duration_ms: number | null;
  a_hash: string | null;
  a_size: number | null;
  a_mtime: number | null;
  a_error: string | null;
  has_row: boolean;
}

/** The decoder as the worker runs it (tests pass their own). */
export interface DjDecoder {
  hash: (path: string, window: DjWindow) => Promise<string>;
  analyze: typeof djDecodeAndAnalyze;
}

const DEFAULT_DECODER: DjDecoder = { hash: (p, w) => djAudioHash(p, w), analyze: (p, w) => djDecodeAndAnalyze(p, w) };

export async function djAnalyzeJob(ctx: WorkerContext, data: DjAnalyzeJobData = {}, decoder: DjDecoder = DEFAULT_DECODER): Promise<Result> {
  if (!(await djEnabled(ctx.sql))) return { skipped: 'dj is off' };
  if (data.localTrackId) return { outcome: await analyzeTrack(ctx, data.localTrackId, data.force === true, decoder) };
  if (data.sweep) return sweep(ctx);
  return { skipped: 'nothing asked' };
}

async function analyzeTrack(ctx: WorkerContext, localTrackId: string, force: boolean, decoder: DjDecoder): Promise<Outcome> {
  const [t] = await ctx.sql<TrackRow[]>`
    select lt.id::text as id, f.rel_path, sr.path as root_path, f.status, f.size_bytes::float8 as size_bytes, f.mtime::float8 as mtime,
           lt.origin, lt.cue_start_ms, lt.duration_ms,
           d.audio_hash as a_hash, d.file_size_bytes::float8 as a_size, d.file_mtime::float8 as a_mtime, d.error as a_error,
           d.local_track_id is not null as has_row
      from local_tracks lt
      join files f on f.id = lt.audio_file_id
      join scan_roots sr on sr.id = f.scan_root_id
      left join dj_track_analysis d on d.local_track_id = lt.id
     where lt.id = ${localTrackId}`;
  if (!t || t.status !== 'present') return 'gone';
  const file = { size: t.size_bytes, mtime: t.mtime };
  const sameFile = t.has_row && t.a_size === file.size && t.a_mtime === file.mtime;
  if (!force && sameFile && !t.a_error) return 'current';

  const full = path.join(t.root_path, t.rel_path);
  const window: DjWindow = t.origin === 'cue' ? { startMs: t.cue_start_ms ?? 0, durationMs: t.duration_ms } : {};
  const log = ctx.logger.child({ job: 'dj.analyze', localTrackId });
  try {
    const audioHash = await decoder.hash(full, window);
    if (!force) {
      // a re-tag: the same audio, a new size and mtime
      if (t.a_hash === audioHash && !t.a_error) {
        await ctx.sql`update dj_track_analysis set file_size_bytes = ${file.size}, file_mtime = ${file.mtime} where local_track_id = ${localTrackId}`;
        return 'rehashed';
      }
      // a copy of audio already measured
      const [twin] = await ctx.sql<Array<{ id: string }>>`
        select local_track_id::text as id from dj_track_analysis
         where audio_hash = ${audioHash} and error is null and local_track_id <> ${localTrackId} limit 1`;
      if (twin) {
        await ctx.sql`
          insert into dj_track_analysis (local_track_id, audio_hash, file_size_bytes, file_mtime, duration_ms, bpm, bpm_confidence,
                                         first_beat_ms, trim_start_ms, trim_end_ms, peaks, analyzed_at, error)
          select ${localTrackId}, audio_hash, ${file.size}, ${file.mtime}, duration_ms, bpm, bpm_confidence,
                 first_beat_ms, trim_start_ms, trim_end_ms, peaks, now(), null
            from dj_track_analysis where local_track_id = ${twin.id}
          on conflict (local_track_id) do update set
            audio_hash = excluded.audio_hash, file_size_bytes = excluded.file_size_bytes, file_mtime = excluded.file_mtime,
            duration_ms = excluded.duration_ms, bpm = excluded.bpm, bpm_confidence = excluded.bpm_confidence,
            first_beat_ms = excluded.first_beat_ms, trim_start_ms = excluded.trim_start_ms, trim_end_ms = excluded.trim_end_ms,
            peaks = excluded.peaks, analyzed_at = now(), error = null`;
        return 'copied';
      }
    }
    const started = Date.now();
    const a = await decoder.analyze(full, window);
    await saveDjAnalysis(ctx.sql, localTrackId, { audioHash, fileSizeBytes: file.size, fileMtime: file.mtime, ...a });
    log.debug({ ms: Date.now() - started, bpm: a.bpm, durationMs: a.durationMs }, 'dj analysis done');
    return 'analyzed';
  } catch (err) {
    const message = (err as Error).message;
    log.warn({ file: full, err: message }, 'dj analysis failed');
    await recordDjError(ctx.sql, localTrackId, message, file);
    return 'failed';
  }
}

/** The next tracks that need analysing, in the sweep's order (one library's only, for a test). */
export async function djSweepCandidates(sql: WorkerContext['sql'], limit: number, libraryId: string | null = null): Promise<string[]> {
  const rows = await sql<Array<{ id: string }>>`
    with q as (
      select e.value->>'id' as id, min(e.n) as n
        from player_queue_state s
        cross join lateral jsonb_array_elements(s.items) with ordinality as e(value, n)
       where e.n > s.idx and e.value->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       group by 1
    ), p as (
      select local_track_id as id, max(started_at) as at from player_plays
       where local_track_id is not null and started_at > now() - ${RECENT_PLAYS}::interval
       group by 1
    )
    select lt.id::text as id
      from local_tracks lt
      join files f on f.id = lt.audio_file_id and f.status = 'present'
      left join dj_track_analysis d on d.local_track_id = lt.id
      left join q on q.id = lt.id::text
      left join p on p.id = lt.id
     where not exists (select 1 from file_deletions fd where fd.file_id = lt.audio_file_id)
       and (${libraryId}::uuid is null or f.library_id = ${libraryId}::uuid)
       and (d.local_track_id is null
            or d.file_size_bytes is distinct from f.size_bytes
            or d.file_mtime is distinct from f.mtime
            or (d.error is not null and d.analyzed_at < now() - ${FAILED_RETRY}::interval))
     order by (q.id is null), q.n, (p.id is null), p.at desc, lt.local_album_id, lt.disc_no nulls first, lt.track_no nulls first, lt.cue_start_ms nulls first, lt.id
     limit ${limit}`;
  return rows.map((r) => r.id);
}

async function sweep(ctx: WorkerContext): Promise<Result> {
  const ids = await djSweepCandidates(ctx.sql, SWEEP_BATCH);
  let queued = 0;
  for (const id of ids) {
    const sent = await ctx.boss.send('dj.analyze', { localTrackId: id }, { singletonKey: `dj:${id}`, priority: DJ_PRIORITY.swept, retryLimit: 1 });
    if (sent) queued++;
  }
  // a full batch: the next sweep runs behind these (lower priority, same queue)
  const more = ids.length === SWEEP_BATCH;
  if (more) await ctx.boss.send('dj.analyze', { sweep: true }, { singletonKey: 'dj:sweep', priority: DJ_PRIORITY.sweep, retryLimit: 1 });
  ctx.logger.info({ job: 'dj.analyze', queued, more }, 'dj sweep');
  return { queued, more };
}
