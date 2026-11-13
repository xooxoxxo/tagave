import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import sharp from 'sharp';
import type { MaintenanceWork } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { markLibraryDirty, onDisk } from '../lib/deletions.js';
import { fileStat, insideRoot, mountIdentity } from '../lib/fileRecovery.js';
import { runMaintenance } from '../lib/maintenance.js';
import { SafeFileWriter } from '../lib/safeFileWriter.js';
import { MutagenTagWriter } from '../lib/tagWriter.js';

export interface EmbedCoverJobData {
  albumId: string;
  fileIds: string[];
  maintenance: MaintenanceWork;
}

const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'front.jpg', 'front.jpeg', 'front.png', 'folder.jpg', 'folder.jpeg', 'folder.png'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED = new Set(['.flac', '.mp3', '.m4a', '.alac', '.mp4']);

async function readLocalCover(sources: { root: string; file: string }[]): Promise<Buffer> {
  const directories = new Map(sources.map(({ root, file }) => [path.dirname(file), root]));
  for (const [directory, root] of directories) {
    const entries = await readdir(directory);
    for (const name of COVER_NAMES) {
      const entry = entries.find((candidate) => candidate.toLowerCase() === name);
      if (!entry) continue;
      const file = path.join(directory, entry);
      await insideRoot(root, file);
      const info = await fileStat(file);
      if (!info?.isFile()) continue;
      if (info.size > MAX_IMAGE_BYTES) throw new Error(`${entry} is larger than 10 MB. Use a smaller image.`);
      return sharp(await readFile(file), { limitInputPixels: 40_000_000 })
        .rotate().resize({ width: 1500, height: 1500, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 }).toBuffer();
    }
  }
  throw new Error('Put a cover.jpg or cover.png in the album folder, then retry.');
}

export async function embedCoverJob(ctx: WorkerContext, data: EmbedCoverJobData): Promise<void> {
  await runMaintenance(ctx, data.maintenance, async (task) => {
    const libraryId = task.row.library_id;
    const { albumId, fileIds } = data;
    await task.update({ stage: 'Checking the album files' });
    const rows = await ctx.sql<{ id: string; rel_path: string; root: string; writable: boolean }[]>`
      select distinct f.id, f.rel_path, r.path as root,
             (r.enabled and r.writable and coalesce(r.probe_writable, true)
               and coalesce(l.settings->'tagWritesEnabled' = 'true'::jsonb, false)) as writable
        from local_tracks t join files f on f.id = t.audio_file_id
        join scan_roots r on r.id = f.scan_root_id and r.library_id = f.library_id
        join libraries l on l.id = f.library_id
       where t.local_album_id = ${albumId} and f.library_id = ${libraryId}
         and f.id = any(${fileIds}::uuid[])
         and not exists (select 1 from file_deletions d where d.file_id = f.id)
       order by f.rel_path, f.id`;
    if (!rows.length || rows.length !== fileIds.length) throw new Error('The album’s files changed. Review them before embedding a cover.');
    if (rows.some((row) => !row.writable)) throw new Error('Enable tag writes and check that the music folders are writable.');
    const sources: Array<typeof rows[number] & { file: string; hasCover: boolean; mount: string }> = [];
    for (const row of rows) {
      const file = await onDisk(row.root, row.rel_path);
      if (!file || !(await fileStat(file))?.isFile()) throw new Error(`Missing audio file: ${path.basename(row.rel_path)}`);
      await insideRoot(row.root, file);
      const hasCover = !!(await parseFile(file)).common.picture?.length;
      if (!hasCover && !SUPPORTED.has(path.extname(file).toLowerCase())) {
        throw new Error(`Cover embedding does not support ${path.basename(file)}.`);
      }
      sources.push({ ...row, file, hasCover, mount: await mountIdentity(row.root) });
    }
    let cover: Buffer | null = null;
    if (sources.some((source) => !source.hasCover)) {
      cover = await readLocalCover(sources);
      const digest = createHash('sha256').update(cover).digest('hex');
      if (task.row.checkpoint?.coverSha && task.row.checkpoint.coverSha !== digest) {
        throw new Error('The local cover changed. Restore the image originally used for this task, then continue.');
      }
      await task.update({ checkpoint: { coverSha: digest } });
    }

    let done = 0;
    const stage = 'Embedding cover in audio files';
    await task.update({ stage, progress: { done, total: sources.length } });
    const writer = new MutagenTagWriter();
    try {
      const safe = new SafeFileWriter(writer);
      for (const source of sources) {
        const stillWritable = async () => {
          await task.current();
          const [current] = await ctx.sql`
            select 1 from files f join scan_roots r on r.id = f.scan_root_id and r.library_id = f.library_id
              join libraries l on l.id = f.library_id
             where f.id = ${source.id} and f.library_id = ${libraryId} and f.rel_path = ${source.rel_path} and r.path = ${source.root}
               and r.enabled and r.writable and coalesce(r.probe_writable, true) and l.settings->'tagWritesEnabled' = 'true'::jsonb
               and exists (select 1 from local_tracks t where t.local_album_id = ${albumId} and t.audio_file_id = f.id)
               and not exists (select 1 from file_deletions d where d.file_id = f.id)`;
          if (!current || await mountIdentity(source.root) !== source.mount) throw new Error('The music folder changed or is read-only.');
          await insideRoot(source.root, source.file);
        };
        await stillWritable();
        if (!source.hasCover && cover) {
          const image = cover;
          const result = await safe.writeVerified(
            source.file,
            (temp) => writer.embedCover(temp, image),
            async (temp) => {
              const pictures = (await parseFile(temp)).common.picture;
              return pictures?.some((picture) => Buffer.from(picture.data).equals(image))
                ? {} : { error: 'Could not verify the embedded cover' };
            },
            stillWritable,
          );
          if (result.error) throw new Error(`${path.basename(source.file)}: ${result.error}`);
        }
        const updated = await stat(source.file);
        await ctx.sql`update files set has_embedded_art = true, size_bytes = ${updated.size},
                  mtime = ${Math.floor(updated.mtimeMs / 1000)}, inode = ${`${updated.dev}:${updated.ino}`}
                  where id = ${source.id}`;
        await task.update({ stage, progress: { done: ++done, total: sources.length } });
      }
    } finally {
      await writer.close();
    }
    await ctx.sql`update gaps set state = 'resolved', resolved_at = now()
      where library_id = ${libraryId} and subject_id = ${albumId} and kind = 'quality' and flag = 'noEmbeddedArt' and state <> 'resolved'`;
    await markLibraryDirty(ctx, libraryId);
    return { state: 'done', stage: 'Cover embedded', progress: { done, total: sources.length } };
  });
}
