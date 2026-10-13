/**
 * The artist dates backfill selects only artists enriched under the old
 * parser (MBID, enriched, no begin date), forces their enrich, and a second
 * run finds nothing left to do.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDb } from '@liner/db';
import pino from 'pino';
import { artistsMissingDates, backfillArtistDates } from './backfillArtistDates.js';
import type { WorkerContext } from './lib/context.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('artist dates backfill (db)', () => {
  let ctx: WorkerContext;
  let client: any;
  const tag = randomUUID().slice(0, 8);
  const ids: Record<string, string> = { stale: randomUUID(), dated: randomUUID(), noMbid: randomUUID(), unenriched: randomUUID(), noDatesOnMb: randomUUID() };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };
    const mbid = () => randomUUID();
    await client`insert into artists (id, mbid, name, enriched_at) values
      (${ids.stale}, ${mbid()}, ${`stale ${tag}`}, now()),
      (${ids.noDatesOnMb}, ${mbid()}, ${`nodates ${tag}`}, now()),
      (${ids.unenriched}, ${mbid()}, ${`unenriched ${tag}`}, null)`;
    await client`insert into artists (id, mbid, name, enriched_at, begin_date) values (${ids.dated}, ${mbid()}, ${`dated ${tag}`}, now(), '1976-01-01')`;
    await client`insert into artists (id, name, enriched_at) values (${ids.noMbid}, ${`nombid ${tag}`}, now())`;
  });

  afterAll(async () => {
    await client`delete from artists where id in ${client(Object.values(ids))}`;
    await client.end({ timeout: 5 });
  });

  const ours = (rows: Array<{ id: string }>) => rows.filter((r) => Object.values(ids).includes(r.id as string)).map((r) => r.id).sort();

  it('selects enriched artists with an MBID and no begin date', async () => {
    expect(ours(await artistsMissingDates(ctx.sql))).toEqual([ids.stale, ids.noDatesOnMb].sort());
  });

  it('forces the enrich of each, counts the outcome, and is idempotent', async () => {
    const forced: string[] = [];
    // stand-in for the enrich job: MusicBrainz has dates for one of the two
    const enrich = async (c: WorkerContext, data: { artistId: string; force?: boolean }) => {
      if (!Object.values(ids).includes(data.artistId)) return; // another test's artist
      expect(data.force).toBe(true);
      forced.push(data.artistId);
      if (data.artistId === ids.stale) await c.sql`update artists set begin_date = '1976-01-01', end_date = '2006-01-01' where id = ${data.artistId}`;
    };
    const dry = await backfillArtistDates(ctx, { dryRun: true, enrich });
    expect(dry.selected).toBeGreaterThanOrEqual(2);
    expect(forced).toEqual([]);

    const first = await backfillArtistDates(ctx, { enrich });
    expect(forced.sort()).toEqual([ids.stale, ids.noDatesOnMb].sort());
    expect(first.filled).toBeGreaterThanOrEqual(1);
    expect(first.failed).toEqual([]);
    const [row] = await client`select begin_date::text as b, end_date::text as e from artists where id = ${ids.stale}`;
    expect(row).toEqual({ b: '1976-01-01', e: '2006-01-01' });

    // the filled artist is not selected again
    expect(ours(await artistsMissingDates(ctx.sql))).toEqual([ids.noDatesOnMb]);
  });
});
