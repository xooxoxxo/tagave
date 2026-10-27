/**
 * The books app (platform step 3, the spike), read-only. Every route answers
 * 404 unless TAGAVE_DEV_APPS names books: an install without the flag has no
 * books routes as far as anyone can tell, and Settings shows nothing.
 *
 *   GET  /api/v1/books                          catalog.read: the works of the books libraries (409 while off)
 *   GET  /api/v1/books/editions/:id/cover       catalog.read: an edition's 300 px cover thumbnail (JPEG, ETag)
 *   GET  /api/v1/settings/books                 system.manage: the Settings › Modules row
 *   PUT  /api/v1/settings/books                 system.manage + fresh step-up, { enabled }: on makes the
 *                                               books library the first time; off keeps every row
 *
 * A books folder is added with the libraries' own scan-root routes on the
 * books library (POST /api/v1/libraries/:id/scan-roots); its scans, parse
 * and books.group do the rest. "Delete its data" is `tagave-doctor
 * purge-module books` (the books tables and the books library with its
 * folders and files).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BOOKS_APP, appAllowed, devAppIds } from '@tagave/core/facets';
import { UnknownModuleError, appLibraryIds, ensureAppLibrary, moduleEnabled, setModuleEnabled } from '@tagave/db';
import { booksModuleSchema, type BookWorkView, type BooksModuleView, type BooksView } from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { requireFreshStepUp } from './stepUp.js';
import { sameSite } from './mcConnections.js';

const sql = () => getAuthHandle().sql;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** No books routes without the dev flag: the same 404 as a route that does not exist. */
function devOnly(): void {
  if (!appAllowed(BOOKS_APP, devAppIds())) throw new ApiError(404, 'Not Found', 'Route not found');
}

async function on(): Promise<void> {
  devOnly();
  if (!(await moduleEnabled(sql(), BOOKS_APP.id))) throw new ApiError(409, 'Conflict', 'Books is turned off.');
}

async function moduleView(): Promise<BooksModuleView> {
  const libs = await appLibraryIds(sql(), BOOKS_APP.id);
  const [c] = await sql()<Array<{ folders: number; works: number; files: number }>>`
    select (select count(*)::int from scan_roots where library_id = any(${libs}::uuid[])) as folders,
           (select count(*)::int from books_works where library_id = any(${libs}::uuid[])) as works,
           (select count(*)::int from files where library_id = any(${libs}::uuid[]) and status = 'present') as files`;
  return { enabled: await moduleEnabled(sql(), BOOKS_APP.id), libraryId: libs[0] ?? null, folders: c!.folders, works: c!.works, files: c!.files };
}

/** The works of the books libraries whose files are present, by sorting title. */
export async function listWorks(): Promise<BookWorkView[]> {
  const libs = await appLibraryIds(sql(), BOOKS_APP.id);
  const rows = await sql()<Array<{ id: string; title: string; series: string | null; series_index: string | null; authors: string[] | null; formats: string[]; cover: string | null }>>`
    select w.id::text, w.title, w.series, w.series_index::text,
           (select array_agg(a.name order by wa.position) from books_work_authors wa join books_authors a on a.id = wa.author_id where wa.work_id = w.id) as authors,
           array_agg(distinct e.format order by e.format) as formats,
           (array_agg(e.id::text order by e.format, e.id) filter (where e.cover_thumb is not null))[1] as cover
      from books_works w
      join books_editions e on e.work_id = w.id
      join files f on f.id = e.file_id and f.status = 'present'
     where w.library_id = any(${libs}::uuid[])
     group by w.id
     order by w.sort_title, w.id`;
  return rows.map((r) => ({
    id: r.id, title: r.title, authors: r.authors ?? [], series: r.series, seriesIndex: r.series_index === null ? null : Number(r.series_index),
    formats: r.formats, coverEditionId: r.cover,
  }));
}

export async function createBooksRoutes(fastify: FastifyInstance) {
  fastify.get('/books', async (): Promise<BooksView> => {
    await on();
    return { works: await listWorks() };
  });

  fastify.get<{ Params: { editionId: string } }>('/books/editions/:editionId/cover', async (request, reply) => {
    await on();
    const { editionId } = request.params;
    if (!UUID_RE.test(editionId)) throw new ApiError(404, 'Not Found', 'No cover for this book');
    const [row] = await sql()<Array<{ bytes: Buffer; sha: Buffer }>>`
      select cover_thumb as bytes, cover_sha256 as sha from books_editions where id = ${editionId} and cover_thumb is not null`;
    if (!row) throw new ApiError(404, 'Not Found', 'No cover for this book');
    const etag = `"${Buffer.from(row.sha).toString('hex')}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, max-age=86400');
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.header('Content-Type', 'image/jpeg').send(Buffer.from(row.bytes));
  });

  fastify.get('/settings/books', async (): Promise<BooksModuleView> => {
    devOnly();
    return moduleView();
  });

  fastify.put('/settings/books', async (request: FastifyRequest): Promise<BooksModuleView> => {
    devOnly();
    sameSite(request);
    const parsed = booksModuleSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'enabled (true or false) is required');
    await requireFreshStepUp(request);
    try {
      await setModuleEnabled(sql(), BOOKS_APP.id, parsed.data.enabled);
    } catch (err) {
      // the flag was set after this app started: its boot made no ledger row yet
      if (err instanceof UnknownModuleError) throw new ApiError(409, 'Conflict', 'Restart tagave with TAGAVE_DEV_APPS=books first.');
      throw err;
    }
    // the books library: one app per library, made the first time books is turned on
    if (parsed.data.enabled) await ensureAppLibrary(sql(), { app: BOOKS_APP.id, name: 'Books', ownerUserId: request.user!.id });
    request.log.info({ event: parsed.data.enabled ? 'module.enable' : 'module.disable', module: BOOKS_APP.id, userId: request.user?.id }, 'books switched');
    return moduleView();
  });
}
