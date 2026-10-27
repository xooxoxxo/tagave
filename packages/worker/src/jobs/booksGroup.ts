/**
 * books.group: the books app's grouping job (platform step 3, the Books
 * spike). The grouping gate (lib/appFiles.ts) sends it, in place of
 * cluster.dir, for a folder whose epub, pdf or cbz files were parsed, went
 * missing, moved or came out of a hold. It brings that folder's editions in
 * line with its files:
 *
 *   a parsed, present book file   an edition (one per file) of the work its title and first
 *                                 author name (a file without a title: its file name), the work's
 *                                 authors in order, and a 300 px cover thumbnail (epub, cbz)
 *   a file that is not present    its edition goes
 *   a held or unparsed file       left as it is (its parse sends this job again)
 *
 * then drops the library's works without editions and authors without works.
 * Off (the books app turned off): nothing. Rides with cluster.dir on the
 * file worker: the covers are read from the files.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { BOOKS_APP } from '@tagave/core/facets';
import { fileTypeHandler, titleFromName, type BookMetadata } from '@tagave/core/files';
import { moduleEnabled } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { escapeLike } from '../lib/helpers.js';
import { openablePath } from './scanParse.js';

export interface BooksGroupJobData {
  libraryId: string;
  scanRootId: string;
  dirPath: string;
}

export interface BooksGroupResult {
  grouped: number;
  removed: number;
  skipped: number;
}

/** The longest side of a cover thumbnail; the aspect ratio is kept (a book cover is not square). */
export const BOOK_COVER_SIZE = 300;

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
/** Sorting title: without a leading article. */
const sortTitle = (t: string) => norm(t).replace(/^(the|a|an)\s+/, '');

interface FileRow {
  id: string;
  rel_path: string;
  status: string;
  handler: string;
  tags_raw: unknown;
  /** text or Date, as the shared client returns timestamptz */
  tags_read_at: Date | string | null;
  reconcile_hold_at: Date | null;
}

async function coverThumb(abs: string, handler: string, metadata: unknown): Promise<{ thumb: Buffer; sha256: Buffer } | null> {
  const h = fileTypeHandler(handler);
  const cover = h?.cover ? await h.cover(abs, metadata) : null;
  if (!cover) return null;
  const thumb = await sharp(cover.bytes, { failOn: 'none' })
    .resize(BOOK_COVER_SIZE, BOOK_COVER_SIZE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { thumb, sha256: createHash('sha256').update(thumb).digest() };
}

export async function booksGroupJob(ctx: WorkerContext, data: BooksGroupJobData): Promise<BooksGroupResult> {
  const out: BooksGroupResult = { grouped: 0, removed: 0, skipped: 0 };
  if (!(await moduleEnabled(ctx.sql, BOOKS_APP.id))) {
    ctx.logger.info({ ...data }, 'books.group: the books app is off, skipping');
    return out;
  }
  const sql = ctx.sql;
  const [root] = await sql<Array<{ path: string; library_id: string }>>`select path, library_id from scan_roots where id = ${data.scanRootId}`;
  if (!root) return out;
  const dir = data.dirPath.replace(/^\/+|\/+$/g, '');
  // the folder's own files (not its subfolders'), of the handlers books claims
  const inDir = dir === ''
    ? sql`strpos(f.rel_path, '/') = 0`
    : sql`f.rel_path like ${`${escapeLike(dir)}/%`} and strpos(substr(f.rel_path, ${dir.length + 2}), '/') = 0`;
  const rows = await sql<FileRow[]>`
    select f.id, f.rel_path, f.status, f.handler, f.tags_raw, f.tags_read_at, f.reconcile_hold_at
      from files f
     where f.scan_root_id = ${data.scanRootId} and f.handler = any(${[...BOOKS_APP.fileTypes]}::text[]) and ${inDir}`;
  const known = new Map((await sql<Array<{ file_id: string; parsed_at: Date | string | null }>>`
    select e.file_id, e.parsed_at
      from books_editions e where e.file_id = any(${rows.map((r) => r.id)}::uuid[])`).map((e) => [e.file_id, e]));

  for (const row of rows) {
    if (row.status !== 'present') {
      const gone = await sql`delete from books_editions where file_id = ${row.id}`;
      out.removed += gone.count;
      continue;
    }
    if (row.reconcile_hold_at !== null || row.tags_read_at === null || row.tags_raw === null) {
      out.skipped += 1;
      continue;
    }
    const m = (typeof row.tags_raw === 'string' ? JSON.parse(row.tags_raw) : row.tags_raw) as BookMetadata;
    const title = m.title ?? titleFromName(row.rel_path);
    const authors = [...new Map((m.authors ?? []).map((a) => [norm(a), a])).entries()];
    const key = `${norm(title)}\u001f${authors[0]?.[0] ?? ''}`;

    // the cover is read again only when the file was parsed again
    const before = known.get(row.id);
    const sameParse = before?.parsed_at != null && new Date(before.parsed_at).getTime() === new Date(row.tags_read_at).getTime();
    let cover: { thumb: Buffer; sha256: Buffer } | null | undefined;
    if (!sameParse) {
      try {
        const abs = await openablePath(root.path, row.rel_path);
        cover = abs ? await coverThumb(abs, row.handler, m) : null;
      } catch (err) {
        ctx.logger.warn({ fileId: row.id, err: (err as Error).message }, 'books.group: cover not read');
        cover = null;
      }
    }

    await sql.begin(async (tx) => {
      const [work] = await tx<Array<{ id: string }>>`
        insert into books_works (library_id, key, title, sort_title, series, series_index)
        values (${root.library_id}, ${key}, ${title}, ${sortTitle(title)}, ${m.series ?? null}, ${m.seriesIndex ?? null})
        on conflict (library_id, key) do update set
          series = coalesce(books_works.series, excluded.series),
          series_index = coalesce(books_works.series_index, excluded.series_index),
          updated_at = now()
        returning id`;
      for (const [i, [nameKey, name]] of authors.entries()) {
        const [a] = await tx<Array<{ id: string }>>`
          insert into books_authors (library_id, name, name_key) values (${root.library_id}, ${name}, ${nameKey})
          on conflict (library_id, name_key) do update set name = books_authors.name
          returning id`;
        await tx`insert into books_work_authors (work_id, author_id, position) values (${work!.id}, ${a!.id}, ${i})
                 on conflict (work_id, author_id) do nothing`;
      }
      const thumb = cover === undefined ? null : cover?.thumb ?? null;
      const sha = cover === undefined ? null : cover?.sha256 ?? null;
      await tx`
        insert into books_editions (file_id, work_id, format, title, isbn13, language, publisher, published, pages, parsed_at, cover_thumb, cover_sha256)
        values (${row.id}, ${work!.id}, ${m.format}, ${title}, ${m.isbn13 ?? null}, ${m.language ?? null}, ${m.publisher ?? null},
                ${m.published ?? null}, ${m.pages ?? null}, ${row.tags_read_at}, ${thumb}, ${sha})
        on conflict (file_id) do update set
          work_id = excluded.work_id, format = excluded.format, title = excluded.title, isbn13 = excluded.isbn13,
          language = excluded.language, publisher = excluded.publisher, published = excluded.published, pages = excluded.pages,
          parsed_at = excluded.parsed_at,
          cover_thumb = case when ${cover === undefined}::boolean then books_editions.cover_thumb else excluded.cover_thumb end,
          cover_sha256 = case when ${cover === undefined}::boolean then books_editions.cover_sha256 else excluded.cover_sha256 end,
          updated_at = now()`;
    });
    out.grouped += 1;
  }

  // what no edition holds any more: works (their author links go with them), then authors
  await sql`delete from books_works w where w.library_id = ${root.library_id}
              and not exists (select 1 from books_editions e where e.work_id = w.id)`;
  await sql`delete from books_authors a where a.library_id = ${root.library_id}
              and not exists (select 1 from books_work_authors wa where wa.author_id = a.id)`;
  ctx.logger.info({ ...data, ...out }, 'books.group');
  return out;
}
