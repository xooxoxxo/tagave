import path from 'node:path';
import type { WorkerContext } from '../lib/context.js';
import { fpcalcFingerprint } from '../lib/fingerprint.js';

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

  ctx.logger.info({ localAlbumId: data.localAlbumId, files: files.length, fingerprinted: ok, failed, skipped: files.length - todo.length }, 'fingerprint.album done');
  if (files.some((f) => f.fingerprint) || ok > 0) {
    await ctx.boss.send('acoustid.lookup', { localAlbumId: data.localAlbumId }, { singletonKey: `acoustid:${data.localAlbumId}` });
  } else {
    await ctx.sql`update local_albums set fingerprinted_at = now(), acoustid_result = 'no_fingerprints' where id = ${data.localAlbumId}`;
  }
}
