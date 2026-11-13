/**
 * Train a library's local decider from the command line and print what the
 * training saw and its held-out figures per band; the same training as the
 * decider.train job.
 *
 *   DATABASE_URL=postgres://… node packages/worker/dist/localDeciderTrain.js train --library <id> --confirm-database <name> \
 *       [--dry-run] [--copy] [--json <file>]
 *
 *   --confirm-database  must name the database DATABASE_URL points at, so the
 *                       tool is never run against the wrong one by accident
 *   --dry-run           train and print only; the database is opened read-only
 *                       and nothing is stored, whatever the module switch says
 *   --copy              store on a restored copy, where the module is off; refused
 *                       on a database named as the live one (LIVE_DATABASE_NAME)
 *   --json              also write the counts, version and metrics to this file
 *
 * Without --dry-run the model is stored as the library's active one, which
 * needs the autotagger on, or --copy. Exit codes: 2 not valid usage or
 * refused before training, 1 the training failed or was refused for what
 * the library holds (too few owner decisions), 0 trained.
 */
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import type { PgBoss } from 'pg-boss';
import { TrainingRefused, type BandMetrics, type LocalTrainMetrics, type TrainResult } from '@tagave/core';
import { autotaggerEnabled, makeDb, storeModel } from '@tagave/db';
import type { WorkerContext } from './lib/context.js';
import { modelRow, trainLibrary } from './jobs/deciderTrain.js';

/** The live database's default name (deploy compose POSTGRES_DB): --copy never stores there. */
export const LIVE_DATABASE_NAME = 'tagave';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const USAGE = 'usage: localDeciderTrain train --library <id> --confirm-database <name> [--dry-run] [--copy] [--json <file>]';

export interface TrainCli { command: 'train'; library: string; confirmDatabase: string; dryRun: boolean; copy: boolean; json?: string }

const VALUE_FLAGS = ['--library', '--confirm-database', '--json'];
const SWITCHES = ['--dry-run', '--copy'];

/** The command line, or why it is not valid usage (flags only, never a value given). */
export function parseCliArgs(argv: string[]): TrainCli | { error: string } {
  const [command, ...rest] = argv;
  if (command !== 'train') return { error: 'unknown command' };
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (SWITCHES.includes(flag)) { switches.add(flag); continue; }
    if (!VALUE_FLAGS.includes(flag)) return { error: /^--[a-z-]{1,38}$/.test(flag) ? `unknown flag ${flag}` : 'unknown argument' };
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` };
    values.set(flag, value);
    i += 1;
  }
  const library = values.get('--library');
  if (!library) return { error: '--library is required' };
  if (!UUID.test(library)) return { error: '--library must be a library id' };
  const confirmDatabase = values.get('--confirm-database');
  if (!confirmDatabase) return { error: '--confirm-database is required' };
  const json = values.get('--json');
  return { command: 'train', library, confirmDatabase, dryRun: switches.has('--dry-run'), copy: switches.has('--copy'), ...(json !== undefined ? { json } : {}) };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const pad = (s: string | number, n: number): string => String(s).padStart(n);

function bandLine(name: string, b: BandMetrics): string {
  return [
    name.padEnd(6), pad(b.decided, 8), pad(pct(b.coverage), 9), pad(b.wrongRelease, 14), pad(b.wrongAlbum, 12),
    pad(b.errorRate === null ? '-' : pct(b.errorRate), 8), pad(pct(b.errorUpper), 8),
  ].join(' ');
}

/** The counts and the metrics table as the command prints them. */
export function renderTraining(t: Pick<TrainResult, 'counts' | 'version'> & { metrics: LocalTrainMetrics }, stored: string | null): string {
  const c = t.counts;
  const m = t.metrics;
  const header = ['band'.padEnd(6), pad('decided', 8), pad('coverage', 9), pad('wrong release', 14), pad('wrong album', 12), pad('error', 8), pad('upper95', 8)].join(' ');
  return [
    `albums ${c.albums}  rows ${c.rows}  owner ${c.owner}  auto ${c.auto}  rejections ${c.rejections}`,
    `model ${t.version}  ${stored ? `stored as ${stored} (active)` : 'not stored'}`,
    `held out: ${m.albums} owner albums (${m.groupedAlbums} by tracklist group), ${m.folds} folds, seed ${m.seed}, cut-off ${m.cutoff}, margin ${m.margin}`,
    header,
    ...m.bands.map((b) => bandLine(b.band, b)),
    'at or above',
    ...m.atOrAbove.map((b) => bandLine(`>=${b.band}`, b)),
    `undecided ${m.undecided}    top pick right ${m.topPickRight.right}/${m.topPickRight.albums} (${pct(m.topPickRight.rate)})`,
  ].join('\n') + '\n';
}

interface Writable { write: (s: string) => unknown }
export interface CliIo { stdout: Writable; stderr: Writable; env: Record<string, string | undefined> }

/** Runs the command; the exit code (2: not valid usage or refused, 1: failed, 0: trained). */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const cli = parseCliArgs(argv);
  if ('error' in cli) { io.stderr.write(`${cli.error}\n${USAGE}\n`); return 2; }
  const url = io.env['DATABASE_URL'];
  if (!url) { io.stderr.write('DATABASE_URL is required\n'); return 2; }

  const { db, client } = await makeDb(url, { readOnly: cli.dryRun });
  // nothing is ever queued from here
  const boss = { send: async () => { throw new Error('the training command queues nothing'); } } as unknown as PgBoss;
  const logger = pino({ level: 'warn' }, { write: (s: string) => { io.stderr.write(s); } });
  const ctx: WorkerContext = { db, sql: client, boss, logger };
  try {
    const [dbName] = await ctx.sql<Array<{ name: string }>>`select current_database() as name`;
    if (dbName?.name !== cli.confirmDatabase) {
      io.stderr.write('refused: --confirm-database does not name the database DATABASE_URL points at\n');
      return 2;
    }
    const [lib] = await ctx.sql`select 1 as x from libraries where id = ${cli.library}`;
    if (!lib) { io.stderr.write('refused: no such library in this database\n'); return 2; }
    if (!cli.dryRun && !(await autotaggerEnabled(ctx.sql))) {
      if (!cli.copy) {
        io.stderr.write('refused: the autotagger is off here; pass --dry-run, or --copy to store on a restored copy\n');
        return 2;
      }
      if (dbName.name === LIVE_DATABASE_NAME) {
        io.stderr.write(`refused: --copy stores on a restored copy, and this database is named ${LIVE_DATABASE_NAME}\n`);
        return 2;
      }
    }

    let trained: TrainResult;
    try {
      trained = await trainLibrary(ctx.sql, cli.library);
    } catch (err) {
      if (err instanceof TrainingRefused) {
        io.stderr.write(`not trained (${err.reason}): ${err.message}\n`);
        return 1;
      }
      throw err;
    }
    const stored = cli.dryRun ? null : await storeModel(ctx.sql, modelRow(cli.library, trained));
    io.stdout.write(renderTraining(trained, stored?.id ?? null));
    if (cli.json) {
      const out = { version: trained.version, dataHash: trained.dataHash, counts: trained.counts, metrics: trained.metrics, stored: stored?.id ?? null };
      await writeFile(cli.json, `${JSON.stringify(out, null, 2)}\n`);
    }
    return 0;
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env }).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
