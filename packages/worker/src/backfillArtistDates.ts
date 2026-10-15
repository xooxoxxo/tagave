/**
 * One-off backfill for artist dates (0.7.6).
 *
 * Until 0.7.6 the MusicBrainz artist lookup read `begin-date` / `end-date`,
 * which MusicBrainz never sends (the dates live in `life-span`), so every
 * enriched artist has no begin or end date. This re-runs the enrich job
 * (forced, so a fresh enrichment is not skipped) for each artist that has a
 * MusicBrainz id, was enriched, and still has no begin date.
 *
 * Idempotent: an artist that gets its dates drops out of the selection. One
 * MusicBrainz has no dates for is selected again on a re-run, but is then
 * answered from the provider cache (key artist-v2, 30 days), not MusicBrainz.
 * Lookups go through the shared MusicBrainz pacer (~1 request a second), so a
 * large library takes a while; --limit runs it in batches.
 *
 *   DATABASE_URL=postgres://… APP_SECRET=… node packages/worker/dist/backfillArtistDates.js [--dry-run] [--limit N]
 *
 * APP_SECRET only matters when the library's provider settings are sealed
 * (the MusicBrainz contact string); without it the lookups still run.
 */
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { PgBoss } from 'pg-boss';
import type { WorkerContext } from './lib/context.js';
import { artistsEnrichJob } from './jobs/artistsEnrich.js';

export interface ArtistMissingDates {
  id: string;
  name: string;
}

/** Artists enriched under the old parser: an MBID, enriched_at set, no begin date. */
export async function artistsMissingDates(sql: WorkerContext['sql'], limit?: number): Promise<ArtistMissingDates[]> {
  const rows = await sql`
    select id, name from artists
     where mbid is not null and enriched_at is not null and begin_date is null
     order by name, id
     ${limit ? sql`limit ${limit}` : sql``}` as unknown as ArtistMissingDates[];
  return rows;
}

export interface BackfillResult {
  selected: number;
  /** artists that have a begin date after their enrich ran */
  filled: number;
  /** enrich ran, but MusicBrainz has no begin date for them */
  noDates: number;
  failed: Array<{ id: string; name: string; error: string }>;
}

export async function backfillArtistDates(
  ctx: WorkerContext,
  opts: { limit?: number; dryRun?: boolean; enrich?: typeof artistsEnrichJob } = {},
): Promise<BackfillResult> {
  const enrich = opts.enrich ?? artistsEnrichJob;
  const todo = await artistsMissingDates(ctx.sql, opts.limit);
  const result: BackfillResult = { selected: todo.length, filled: 0, noDates: 0, failed: [] };
  if (opts.dryRun) return result;
  for (const artist of todo) {
    try {
      await enrich(ctx, { artistId: artist.id, force: true });
      const [row] = await ctx.sql`select begin_date, enrich_error from artists where id = ${artist.id}` as unknown as Array<{
        begin_date: string | Date | null; enrich_error: string | null;
      }>;
      if (row?.begin_date) result.filled++;
      else if (row?.enrich_error) result.failed.push({ ...artist, error: row.enrich_error });
      else result.noDates++;
    } catch (err) {
      // a rate-limit error is rethrown by the job for pg-boss to retry; here
      // it is recorded and the run goes on (a re-run picks the artist up)
      result.failed.push({ ...artist, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitAt = args.indexOf('--limit');
  const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    console.error('--limit takes a positive whole number');
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }
  const { db, client } = await makeDb(url);
  const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
  // the enrich job does not queue anything: no pg-boss client is started
  const ctx: WorkerContext = { db, sql: client, boss: {} as PgBoss, logger };
  try {
    const result = await backfillArtistDates(ctx, { ...(limit ? { limit } : {}), dryRun });
    if (dryRun) {
      console.log(`${result.selected} artists have no dates and would be fetched again`);
    } else {
      console.log(`${result.selected} artists fetched again: ${result.filled} have dates now, ${result.noDates} have none on MusicBrainz, ${result.failed.length} failed`);
      for (const f of result.failed) console.log(`  failed: ${f.name} (${f.id}): ${f.error}`);
    }
    process.exitCode = result.failed.length ? 1 : 0;
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
