import path from 'node:path';
import type { WorkerContext } from '../lib/context.js';
import { FPCALC_LENGTH_S, fpcalcFingerprint, fpcalcSliceFingerprint } from '../lib/fingerprint.js';

export interface FingerprintAlbumJobData {
  localAlbumId: string;
  /** re-run fpcalc even for files that already carry a fingerprint */
  force?: boolean;
}

/** fpcalc decodes through FFmpeg; two at a time keeps a NAS mount and the host CPU civil. */
const CONCURRENCY = Number(process.env['FINGERPRINT_CONCURRENCY'] ?? 2);

interface FileRow {
  id: string;
  rel_path: string;
  root_path: string;
  fingerprint: string | null;
  fingerprinted_at: Date | null;
}

interface CueTrackRow {
  id: string;
  cue_start_ms: number;
  duration_ms: number | null;
  fingerprint: string | null;
  fingerprinted_at: Date | null;
  rel_path: string;
  root_path: string;
}

/**
 * IDN-5, file-worker half: fingerprint every audio file of an album once
 * (a cue image counts once however many virtual tracks it carries), then
 * hand the album to acoustid.lookup on the identify worker.
 */
export async function fingerprintAlbumJob(ctx: WorkerContext, data: FingerprintAlbumJobData): Promise<void> {
  const files = (await ctx.sql`
    select distinct af.id, af.rel_path, sr.path as root_path, af.fingerprint, af.fingerprinted_at
    from local_tracks lt
    join audio_files af on af.id = lt.audio_file_id
    join scan_roots sr on sr.id = af.scan_root_id
    where lt.local_album_id = ${data.localAlbumId}
      and af.status in ('present', 'error')`) as unknown as FileRow[];
  // 'error' = the tag parser failed on a file that is still on disk (870 such
  // files in the owner's library, many of them APE rips) — exactly the albums a
  // fingerprint can still identify, so fpcalc gets a go at them too; only
  // 'missing' and 'archived' files are skipped.
  const todo = files.filter((f) => data.force || (!f.fingerprint && !f.fingerprinted_at));
  let ok = 0;
  let failed = 0;

  const queue = [...todo];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const full = path.join(f.root_path, f.rel_path);
      try {
        const fp = await fpcalcFingerprint(full);
        await ctx.sql`
          update audio_files
          set fingerprint = ${fp.fingerprint}, fingerprint_duration = ${Math.round(fp.durationS)},
              fingerprinted_at = now(), fingerprint_error = null
          where id = ${f.id}`;
        ok++;
      } catch (err) {
        const message = (err as Error).message.slice(0, 500);
        await ctx.sql`update audio_files set fingerprinted_at = now(), fingerprint_error = ${message} where id = ${f.id}`;
        failed++;
        ctx.logger.warn({ file: full, err: message }, 'fingerprint failed');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, todo.length)) }, worker));

  // Cue images: the file fingerprint covers the first two minutes of a whole
  // album and never matches a recording; each virtual track gets its own slice.
  const cueTracks = (await ctx.sql`
    select lt.id, lt.cue_start_ms, lt.duration_ms, lt.fingerprint, lt.fingerprinted_at, af.rel_path, sr.path as root_path
    from local_tracks lt
    join audio_files af on af.id = lt.audio_file_id
    join scan_roots sr on sr.id = af.scan_root_id
    where lt.local_album_id = ${data.localAlbumId} and lt.origin = 'cue'
      and lt.cue_start_ms is not null and af.status in ('present', 'error')
    order by lt.cue_start_ms`) as unknown as CueTrackRow[];
  const cueTodo = cueTracks.filter((t) => data.force || (!t.fingerprint && !t.fingerprinted_at));
  let cueOk = 0;
  let cueFailed = 0;
  const cueQueue = [...cueTodo];
  const cueWorker = async () => {
    for (let t = cueQueue.shift(); t; t = cueQueue.shift()) {
      const full = path.join(t.root_path, t.rel_path);
      const durationS = t.duration_ms ? Math.max(1, Math.round(t.duration_ms / 1000)) : FPCALC_LENGTH_S;
      try {
        const fp = await fpcalcSliceFingerprint(full, t.cue_start_ms / 1000, { lengthS: Math.min(FPCALC_LENGTH_S, durationS) });
        await ctx.sql`
          update local_tracks
          set fingerprint = ${fp}, fingerprint_duration = ${durationS}, fingerprinted_at = now(), fingerprint_error = null
          where id = ${t.id}`;
        cueOk++;
      } catch (err) {
        const message = (err as Error).message.slice(0, 500);
        await ctx.sql`update local_tracks set fingerprinted_at = now(), fingerprint_error = ${message} where id = ${t.id}`;
        cueFailed++;
        ctx.logger.warn({ file: full, startMs: t.cue_start_ms, err: message }, 'fingerprint slice failed');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, cueTodo.length)) }, cueWorker));

  ctx.logger.info({
    localAlbumId: data.localAlbumId, files: files.length, fingerprinted: ok, failed, skipped: files.length - todo.length,
    cueTracks: cueTracks.length, cueFingerprinted: cueOk, cueFailed,
  }, 'fingerprint.album done');
  if (files.some((f) => f.fingerprint) || ok > 0 || cueTracks.some((t) => t.fingerprint) || cueOk > 0) {
    await ctx.boss.send('acoustid.lookup', { localAlbumId: data.localAlbumId }, { singletonKey: `acoustid:${data.localAlbumId}` });
  } else {
    await ctx.sql`update local_albums set fingerprinted_at = now(), acoustid_result = 'no_fingerprints' where id = ${data.localAlbumId}`;
  }
}
