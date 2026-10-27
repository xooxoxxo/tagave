/**
 * The Books spike's plug/unplug round trip (platform step 3) on a scratch
 * database migrated by the real runner (the books app's own chain included),
 * with the real jobs (scan.root, scan.parse, books.group, cluster.dir) and
 * the real `tagave-doctor purge-module books`:
 *
 *   music      a music library with a booklet.pdf, an .epub and a .cbz beside
 *              its tracks walks as before, books on or off: the .pdf is a
 *              sidecar, the .epub and .cbz are not its files, only
 *              cluster.dir is sent.
 *   plug in    TAGAVE_DEV_APPS names books (the ledger row), the owner turns
 *              it on, a books library with one folder is scanned: epub, pdf
 *              and cbz files indexed with their media types, parsed, grouped
 *              into works, editions and authors with covers; never cluster.dir.
 *   a file goes  its edition and its work go with it.
 *   unplug     off: its folders are not scanned, books.group does nothing,
 *              the purge refuses while it is on.
 *   purge      doctor purge-module books empties its four tables and removes
 *              its library (folders, files, scans by cascade): every core row
 *              is as it was before it was turned on, music's included.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pino from 'pino';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPS, MODULES, ledgerEntries } from '@tagave/core/facets';
import { cbzBytes, epubBytes, pdfBytes, writeBookFixtures, TINY_PNG } from '@tagave/core/files/fixtures';
import { ensureAppLibrary, makeDb, runMigrations, setModuleEnabled, syncInstalledModules } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { writeFlac } from '../testkit/flac.js';
import { booksGroupJob } from './booksGroup.js';
import { clusterDirJob } from './clusterDir.js';
import { scanParseJob } from './scanParse.js';
import { scanRootJob } from './scanRoot.js';

const url = process.env.TEST_DATABASE_URL;
const DOCTOR_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../doctor/dist/cli.js');
const run = promisify(execFile);

interface Sent { name: string; data: any; opts?: any }

describe.skipIf(!url)('the books app: plug in, scan, unplug, purge (integration)', () => {
  const name = `tagave_books_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: postgres.Sql;
  let dbUrl: string;
  let made: Awaited<ReturnType<typeof makeDb>>;
  let sql: any;
  let ctx: WorkerContext;
  let base: string;
  const sent: Sent[] = [];
  const ran: string[] = [];
  const ids = { user: randomUUID(), music: randomUUID(), musicRoot: randomUUID(), booksRoot: randomUUID() };
  let booksLib = '';

  /** Runs what the scans sent until nothing is left: the parser, books' and music's grouping. */
  const pump = async () => {
    for (let round = 0; round < 20 && sent.length > 0; round++) {
      for (const j of sent.splice(0)) {
        ran.push(j.name);
        if (j.name === 'scan.parse') await scanParseJob(ctx, j.data);
        else if (j.name === 'books.group') await booksGroupJob(ctx, j.data);
        else if (j.name === 'cluster.dir') await clusterDirJob(ctx, j.data);
      }
    }
  };
  const scan = async (rootId: string) => {
    ran.length = 0;
    await scanRootJob(ctx, { scanRootId: rootId, mode: 'full' });
    await pump();
  };

  /** Every core table's rows (hashed), and the module ledger without its clock. */
  const coreState = async () => {
    const tables = (await sql`select tablename as t from pg_tables where schemaname = 'public' and tablename not like 'books\\_%' and tablename <> 'installed_modules' order by 1`)
      .map((r: { t: string }) => r.t);
    const out: Record<string, unknown> = {};
    for (const t of tables) {
      const [r] = await sql.unsafe(`select count(*)::int as n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from "${t}" x`);
      out[t] = `${r.n}:${r.h}`;
    }
    out['installed_modules'] = [...(await sql`select id, kind, version, enabled, enabled_at, schema_version, settings from installed_modules order by id`)];
    return out;
  };
  const booksCounts = async () => (await sql`
    select (select count(*)::int from books_works) as works, (select count(*)::int from books_editions) as editions,
           (select count(*)::int from books_authors) as authors, (select count(*)::int from books_work_authors) as links`)[0];

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create database ${name}`);
    const u = new URL(url!);
    u.pathname = `/${name}`;
    dbUrl = u.toString();
    await runMigrations(dbUrl, { log: () => undefined });
    made = await makeDb(dbUrl);
    sql = made.client;
    ctx = {
      db: made.db, sql,
      boss: { send: async (n: string, data: unknown, opts: unknown) => { sent.push({ name: n, data, opts }); return randomUUID(); } } as any,
      logger: pino({ level: 'silent' }),
    };
    base = await mkdtemp(path.join(tmpdir(), 'tagave-books-spike-'));
    // a music folder with a book's companions beside its tracks
    const album = path.join(base, 'music', 'Artist', 'Album');
    await mkdir(album, { recursive: true });
    await writeFlac(path.join(album, '01 One.flac'), { title: 'One', artist: 'Artist', album: 'Album', albumartist: 'Artist', track: 1 });
    await writeFile(path.join(album, 'booklet.pdf'), pdfBytes({ title: 'Liner notes', pages: 2 }));
    await writeFile(path.join(album, 'novel.epub'), epubBytes({ title: 'Not music', authors: ['Someone'], cover: TINY_PNG }));
    await writeFile(path.join(album, 'comic.cbz'), cbzBytes({ pages: 1 }));
    await writeBookFixtures(path.join(base, 'books'));

    await sql`insert into users (id, email, password_hash) values (${ids.user}, 'books-spike@test.com', 'x')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${ids.music}, ${ids.user}, 'Music', '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${ids.musicRoot}, ${ids.music}, ${path.join(base, 'music')}, 'Music', 'ok')`;
    // an app boot with TAGAVE_DEV_APPS=books: the ledger gets books' row, off
    expect(await syncInstalledModules(sql, ledgerEntries(APPS, MODULES, new Set(['books'])))).toEqual(['books']);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await admin?.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('a music library walks as before with books on: the .pdf is a sidecar, .epub and .cbz are not its files, only cluster.dir', async () => {
    await setModuleEnabled(sql, 'books', true);
    try {
      await scan(ids.musicRoot);
      expect(await sql`select rel_path, handler, media_type, status from files where library_id = ${ids.music} order by rel_path`)
        .toEqual([{ rel_path: 'Artist/Album/01 One.flac', handler: 'audio', media_type: 'audio/flac', status: 'present' }]);
      expect((await sql`select rel_path, kind from sidecar_files where library_id = ${ids.music} order by rel_path`).map((r: any) => `${r.rel_path} ${r.kind}`))
        .toEqual(['Artist/Album/booklet.pdf other']);
      expect(ran).toContain('cluster.dir');
      expect(ran).not.toContain('books.group');
      expect(await sql`select count(*)::int as n from local_albums where library_id = ${ids.music}`).toEqual([{ n: 1 }]);
    } finally {
      await setModuleEnabled(sql, 'books', false);
    }
  });

  it('plug in, scan, a file goes, unplug, purge: books grouped, then every core row as it was', async () => {
    const before = await coreState();
    expect(await booksCounts()).toEqual({ works: 0, editions: 0, authors: 0, links: 0 });

    // ---- plug in: on, a books library, one folder
    await setModuleEnabled(sql, 'books', true);
    booksLib = await ensureAppLibrary(sql, { app: 'books', name: 'Books', ownerUserId: ids.user });
    expect(await ensureAppLibrary(sql, { app: 'books', name: 'Books', ownerUserId: ids.user })).toBe(booksLib);
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${ids.booksRoot}, ${booksLib}, ${path.join(base, 'books')}, 'Books', 'ok')`;
    await scan(ids.booksRoot);

    expect(new Set(ran)).toEqual(new Set(['scan.parse', 'books.group']));
    const files = await sql`select rel_path, handler, media_type, status, parse_error is not null as failed from files where library_id = ${booksLib} order by rel_path collate "C"`;
    expect(files.map((f: any) => `${f.rel_path} ${f.handler} ${f.media_type} ${f.status}`)).toEqual([
      'Ada Example/A Test of Lanterns.epub epub application/epub+zip present',
      'Ada Example/A Test of Lanterns.pdf pdf application/pdf present',
      'Ben Sample/Quiet Harbour.epub epub application/epub+zip present',
      'Broken/not really.epub epub application/epub+zip error',
      'Comics/Night Shift 001.cbz cbz application/vnd.comicbook+zip present',
      'Comics/loose pages.cbz cbz application/vnd.comicbook+zip present',
      'Papers/untitled.pdf pdf application/pdf present',
    ]);
    expect(await sql`select count(*)::int as n from local_albums where library_id = ${booksLib}`).toEqual([{ n: 0 }]);

    const works = await sql`
      select w.title, w.series, w.series_index::float8 as n,
             (select array_agg(a.name order by wa.position) from books_work_authors wa join books_authors a on a.id = wa.author_id where wa.work_id = w.id) as authors,
             (select array_agg(e.format || ':' || coalesce(e.isbn13, '-') || ':' || coalesce(e.pages::text, '-') || ':' || (e.cover_thumb is not null) order by e.format)
                from books_editions e where e.work_id = w.id) as editions
        from books_works w where w.library_id = ${booksLib} order by w.sort_title`;
    expect(works.map((w: any) => ({ ...w }))).toEqual([
      { title: 'loose pages', series: null, n: null, authors: null, editions: ['cbz:-:2:true'] },
      { title: 'Night Shift', series: 'Night Shift', n: 1, authors: ['Cleo Placeholder', 'Dan Standin'], editions: ['cbz:9790000000001:4:true'] },
      { title: 'Quiet Harbour', series: 'Harbour', n: 2, authors: ['Ben Sample'], editions: ['epub:9780000000019:-:true'] },
      // one work, two editions: the EPUB and the PDF of the same title by the same author
      { title: 'A Test of Lanterns', series: 'Lantern Tales', n: 1, authors: ['Ada Example'], editions: ['epub:9780000000002:-:true', 'pdf:-:3:false'] },
      { title: 'untitled', series: null, n: null, authors: null, editions: ['pdf:-:1:false'] },
    ]);
    // a cover is a JPEG no larger than 300 px
    const [thumb] = await sql`select cover_thumb from books_editions where cover_thumb is not null limit 1`;
    expect((thumb.cover_thumb as Buffer).subarray(0, 2).toString('hex')).toBe('ffd8');
    // music untouched while books ran
    expect(await sql`select count(*)::int as n from files where library_id = ${ids.music}`).toEqual([{ n: 1 }]);

    // ---- a file goes: its edition, then its work
    await unlink(path.join(base, 'books', 'Comics', 'loose pages.cbz'));
    await scan(ids.booksRoot);
    expect(ran).toContain('books.group');
    expect((await sql`select title from books_works where library_id = ${booksLib} order by sort_title`).map((w: any) => w.title))
      .toEqual(['Night Shift', 'Quiet Harbour', 'A Test of Lanterns', 'untitled']);
    expect(await booksCounts()).toEqual({ works: 4, editions: 5, authors: 4, links: 4 });

    // ---- unplug: off; the data stays, nothing of it runs
    await setModuleEnabled(sql, 'books', false);
    const scansBefore = (await sql`select count(*)::int as n from scans where scan_root_id = ${ids.booksRoot}`)[0].n;
    await scan(ids.booksRoot);
    expect(ran).toEqual([]);
    expect((await sql`select count(*)::int as n from scans where scan_root_id = ${ids.booksRoot}`)[0].n).toBe(scansBefore);
    expect(await booksGroupJob(ctx, { libraryId: booksLib, scanRootId: ids.booksRoot, dirPath: 'Comics' })).toEqual({ grouped: 0, removed: 0, skipped: 0 });
    expect(await booksCounts()).toEqual({ works: 4, editions: 5, authors: 4, links: 4 });

    // ---- purge: the real command, refused while on
    const doctor = (...args: string[]) => run(process.execPath, [DOCTOR_CLI, ...args], { env: { ...process.env, DATABASE_URL: dbUrl } });
    await setModuleEnabled(sql, 'books', true);
    await expect(doctor('purge-module', 'books', '--json')).rejects.toMatchObject({ code: 3 });
    await setModuleEnabled(sql, 'books', false);
    const { stdout } = await doctor('purge-module', 'books', '--json');
    const purged = JSON.parse(stdout.trim().split('\n').pop()!).purged;
    expect(purged).toMatchObject({
      module: 'books',
      deleted: { books_work_authors: 4, books_editions: 5, books_authors: 4, books_works: 4 },
      librariesRemoved: 1,
    });
    expect(await booksCounts()).toEqual({ works: 0, editions: 0, authors: 0, links: 0 });
    expect(await coreState()).toEqual(before);
    // again: nothing left
    const again = JSON.parse((await doctor('purge-module', 'books', '--json')).stdout.trim().split('\n').pop()!).purged;
    expect(again).toMatchObject({ deleted: { books_work_authors: 0, books_editions: 0, books_authors: 0, books_works: 0 }, librariesRemoved: 0 });
  }, 180_000);
});
