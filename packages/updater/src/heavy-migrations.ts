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

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

/** The heavy migrations among the image's files that the database has not applied. */
export function pendingHeavy(imageFiles: string, applied: string, table: HeavyMigration[] = HEAVY_MIGRATIONS): Array<{ name: string; migration: HeavyMigration }> {
  const done = new Set(lines(applied));
  const out: Array<{ name: string; migration: HeavyMigration }> = [];
  for (const name of lines(imageFiles)) {
    if (!name.endsWith('.sql') || done.has(name)) continue;
    const migration = table.find((m) => m.file.test(name));
    if (migration) out.push({ name, migration });
  }
  return out;
}
