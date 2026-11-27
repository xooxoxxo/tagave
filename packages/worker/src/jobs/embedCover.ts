/**
 * files.embedCover: the album folder's cover into each file that has none.
 * Every file call goes through the file gate (the cover's folder listing and
 * read, the files' stats and tags, the safe write itself), so a dead share
 * parks the task (runMaintenance) and it comes back on its own.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { IAudioMetadata } from 'music-metadata';
import sharp from 'sharp';
import type { MaintenanceWork } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { markLibraryDirty } from '../lib/deletions.js';
import { fileGate } from '../lib/fileGate.js';
import type { DirPage } from '../lib/fileHelper.js';
import { gateInsideRoot, gateLstat, gateMountIdentity, gateOnDisk, type GateStat } from '../lib/gatedPaths.js';
import { runMaintenance } from '../lib/maintenance.js';
import { requireOnline } from '../lib/parking.js';
import { SafeFileWriter } from '../lib/safeFileWriter.js';

export interface EmbedCoverJobData {
  albumId: string;
  fileIds: string[];
  maintenance: MaintenanceWork;
}

const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'front.jpg', 'front.jpeg', 'front.png', 'folder.jpg', 'folder.jpeg', 'folder.png'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED = new Set(['.flac', '.mp3', '.m4a', '.alac', '.mp4']);

/** Every name in a folder on the share, through the gate. */
async function listNames(rootId: string, directory: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | null = null;
  do {
    const page: DirPage = await fileGate().run<DirPage>(rootId, { op: 'readdirPage', path: directory, cursor });
    for (const e of page.entries) names.push(e.name);
    cursor = page.cursor;
  } while (cursor !== null);
  return names;
}

async function readLocalCover(sources: { root: string; root_id: string; file: string }[]): Promise<Buffer> {
  const directories = new Map(sources.map(({ root, root_id, file }) => [path.dirname(file), { root, rootId: root_id }]));
  for (const [directory, { root, rootId }] of directories) {
    const entries = await listNames(rootId, directory);
    for (const name of COVER_NAMES) {
      const entry = entries.find((candidate) => candidate.toLowerCase() === name);
      if (!entry) continue;
      const file = path.join(directory, entry);
      await gateInsideRoot(rootId, root, file);
      const info = await gateLstat(rootId, file);
      if (!info?.isFile) continue;
      if (Number(info.size) > MAX_IMAGE_BYTES) throw new Error(`${entry} is larger than 10 MB. Use a smaller image.`);
      const bytes = await fileGate().run<Uint8Array>(rootId, { op: 'readSmall', path: file, maxBytes: MAX_IMAGE_BYTES });
      return sharp(Buffer.from(bytes), { limitInputPixels: 40_000_000 })
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
    const rows = await ctx.sql<{ id: string; rel_path: string; root: string; root_id: string; writable: boolean }[]>`
      select distinct f.id, f.rel_path, r.path as root, r.id::text as root_id,
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
    // a folder the watch reads offline parks at once, without waiting for a deadline
    for (const rootId of new Set(rows.map((row) => row.root_id))) await requireOnline(ctx, rootId);
    // one writer per music folder: the gate counts a write that hangs against that folder
    const writers = new Map<string, SafeFileWriter>();
    const writerFor = (rootId: string) => {
      let w = writers.get(rootId);
      if (!w) writers.set(rootId, (w = new SafeFileWriter(rootId)));
      return w;
    };
    const sources: Array<typeof rows[number] & { file: string; hasCover: boolean; mount: string }> = [];
    for (const row of rows) {
      const file = await gateOnDisk(row.root_id, row.root, row.rel_path);
      if (!file || !(await gateLstat(row.root_id, file))?.isFile) throw new Error(`Missing audio file: ${path.basename(row.rel_path)}`);
      await gateInsideRoot(row.root_id, row.root, file);
      // the temp copy a cut-off embed left beside the file (its helper was killed) goes first (ruling R9)
      await writerFor(row.root_id).removeStaleTemps(file);
      const meta = await fileGate().run<IAudioMetadata>(row.root_id, { op: 'parseAudio', path: file });
      const hasCover = !!meta.common.picture?.length;
      if (!hasCover && !SUPPORTED.has(path.extname(file).toLowerCase())) {
        throw new Error(`Cover embedding does not support ${path.basename(file)}.`);
      }
      sources.push({ ...row, file, hasCover, mount: await gateMountIdentity(row.root_id, row.root) });
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
        if (!current || await gateMountIdentity(source.root_id, source.root) !== source.mount) throw new Error('The music folder changed or is read-only.');
        await gateInsideRoot(source.root_id, source.root, source.file);
      };
      // Checked before the write, and again right before the rename: the helper
      // prepares the temp copy, the worker checks, then the helper publishes it
      // (only while the file itself is the one it copied).
      await stillWritable();
      if (!source.hasCover && cover) {
        const result = await writerFor(source.root_id).embedCover(source.file, cover, stillWritable);
        if (result.error) throw new Error(`${path.basename(source.file)}: ${result.error}`);
      }
      const updated = await fileGate().run<GateStat>(source.root_id, { op: 'stat', path: source.file });
      await ctx.sql`update files set has_embedded_art = true, size_bytes = ${Number(updated.size)},
                mtime = ${Math.floor(Number(updated.mtimeMs) / 1000)}, inode = ${`${updated.dev}:${updated.ino}`}
                where id = ${source.id}`;
      await task.update({ stage, progress: { done: ++done, total: sources.length } });
    }
    await ctx.sql`update gaps set state = 'resolved', resolved_at = now()
      where library_id = ${libraryId} and subject_id = ${albumId} and kind = 'quality' and flag = 'noEmbeddedArt' and state <> 'resolved'`;
    await markLibraryDirty(ctx, libraryId);
    return { state: 'done', stage: 'Cover embedded', progress: { done, total: sources.length } };
  });
}
