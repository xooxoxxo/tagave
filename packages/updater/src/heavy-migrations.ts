/**
 * Migrations that write a lot into the database while they run, so the
 * space preflight can count them. The target's migration files are read
 * from its app image once preflight has pulled it (a manifest does not list
 * them), and compared with the ones the database has applied. Before the
 * pull nothing is known, so only the re-check after the download counts
 * them; the new app checks again before it migrates (doctor premigrate).
 *
 * Keyed by file name, not number: a release may renumber a migration that
 * has not shipped yet.
 */

export interface HeavyMigration {
  /** The migration file, by name. */
  file: RegExp;
  /** What it does, for the space check's parts. */
  what: string;
  /** One number: the bytes it copies (psql -tA). Runs only while the migration is pending. */
  bytesSql: string;
  /** It needs that many bytes this many times over while it runs. */
  factor: number;
}

export const HEAVY_MIGRATIONS: HeavyMigration[] = [
  {
    // 0046: the cover thumbnails move from images.thumb_bytes into
    // cover_thumbs: the new table plus the write-ahead log, while the old
    // TOAST stays until a vacuum.
    file: /^\d{4}_cover_thumbs\.sql$/,
    what: 'moving the cover thumbnails into their own table',
    bytesSql: 'select coalesce(sum(octet_length(thumb_bytes)), 0) from images',
    factor: 3,
  },
];

/** Where the app image keeps the migrations (docker/app.Dockerfile: WORKDIR /app, packages/db/migrations). */
export const IMAGE_MIGRATIONS_DIR = '/app/packages/db/migrations';

/**
 * The ledger's rows as entries (@tagave/db readLedger): a core file by name,
 * an app's or module's own as <id>/<name>. Either ledger shape (0066 added
 * `module`); no double quotes, for psql -c "…".
 */
export const LEDGER_ENTRIES_SQL =
  "select case when coalesce(to_jsonb(m)->>'module', 'core') = 'core' then name else (to_jsonb(m)->>'module') || '/' || name end from _migrations m";

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * One line of the image's listing (`find <dir> -name '*.sql'`, or a bare
 * name) as a ledger entry: <dir>/0046_x.sql → 0046_x.sql, an app's or
 * module's own <dir>/modules/<id>/0001_x.sql → <id>/0001_x.sql. Null for
 * anything else.
 */
export function imageMigrationEntry(line: string, dir: string = IMAGE_MIGRATIONS_DIR): string | null {
  const rel = line.startsWith(`${dir}/`) ? line.slice(dir.length + 1) : line.replace(/^\.\//, '');
  if (!rel.endsWith('.sql')) return null;
  const parts = rel.split('/');
  if (parts.length === 1) return rel;
  if (parts.length === 3 && (parts[0] === 'apps' || parts[0] === 'modules')) return `${parts[1]}/${parts[2]}`;
  return null;
}

/**
 * The heavy migrations among the image's files that the database has not
 * applied, the core chain's and every app's and module's own. `applied`
 * holds ledger entries (LEDGER_ENTRIES_SQL); a module's heavy migration is
 * listed by its entry (/^decider\/\d{4}_x\.sql$/).
 */
export function pendingHeavy(imageFiles: string, applied: string, table: HeavyMigration[] = HEAVY_MIGRATIONS): Array<{ name: string; migration: HeavyMigration }> {
  const done = new Set(lines(applied));
  const out: Array<{ name: string; migration: HeavyMigration }> = [];
  for (const line of lines(imageFiles)) {
    const name = imageMigrationEntry(line);
    if (name === null || done.has(name)) continue;
    const migration = table.find((m) => m.file.test(name));
    if (migration) out.push({ name, migration });
  }
  return out;
}
