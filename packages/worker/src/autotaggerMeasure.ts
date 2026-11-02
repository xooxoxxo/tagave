/**
 * Measure what Jev costs per album before any real run, on a restored copy
 * of the library.
 *
 *   preview  one album's request, exactly as a measurement sends it (the
 *            same builder, population and options as decider.run). Nothing
 *            is sent; the database is opened read-only.
 *   measure  a measure-population decider run (the largest albums in
 *            review plus a seeded sample of the rest) in this process, then
 *            cost and size figures from the run's own calls and decisions,
 *            and a projection for the whole queue. It writes the run, its
 *            calls and its decisions; never a match or a batch.
 *
 *   DATABASE_URL=postgres://… node packages/worker/dist/autotaggerMeasure.js preview --library <id> [--album <id>] [--model jev-latest]
 *   DATABASE_URL=postgres://… node packages/worker/dist/autotaggerMeasure.js measure --library <id> \
 *       --price-per-mtok <n> --currency <XXX> --max-spend <n> --key-stdin --payload-approved --confirm-database <name> \
 *       [--sample 190] [--largest 10] [--model jev-latest] [--json <file>]
 *
 * measure refuses (exit code 2) unless every safety flag is given:
 *   --key-stdin           the key is read from stdin (piped, never a terminal), trimmed;
 *                         it is never taken from the command line or the environment
 *                         and never printed
 *   --payload-approved    the owner has reviewed `preview` output (a restored copy
 *                         has no record of the payload being seen)
 *   --confirm-database    must name the database DATABASE_URL points at, so the tool
 *                         is never run against the live database by accident
 * A run with rejected requests is a result (exit code 0); a refused key or a
 * run that stopped for another reason exits 1.
 */
import { randomInt } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import type { PgBoss } from 'pg-boss';
import { NotSendableError, jevSpecHash, requestForAlbum, requestOptions, type Decider, type JevRequest } from '@tagave/core';
import { autotaggerConfig, makeDb, type Price } from '@tagave/db';
import type { WorkerContext } from './lib/context.js';
import { loadEvidence, loadEvidenceMany } from './lib/evidenceStore.js';
import { MEASURE_LARGEST, MEASURE_SAMPLE, albumPopulation, populationAlbumIds } from './lib/deciderPopulation.js';
import { jevDecider } from './lib/jevDecider.js';
import { typesafeBaseUrl } from './lib/jevClient.js';
import { RUN_MAX_RETRIES, deciderRunJob } from './jobs/deciderRun.js';

export const DEFAULT_MODEL = 'jev-latest';
/** The run every measurement is: its request options are this population's. */
const POPULATION = 'measure';
/** Albums the preview looks through, in loads of PREVIEW_CHUNK, for one it can show. */
const PREVIEW_SCAN_LIMIT = 1000;
const PREVIEW_CHUNK = 100;

export interface MeasureOptions { libraryId: string; sample: number; largest: number; model: string; price: Price; maxSpend: number }
export interface MeasureReport {
  runId: string; albumsSent: number; reused: number; outcomes: Record<string, number>;
  inputTokens: { mean: number; median: number; p95: number; max: number };
  costPerAlbum: { mean: number; median: number; p95: number }; currency: string; spent: number;
  queue: { needsReview: number; weak: number }; projected: { needsReview: number; withWeak: number };
  requestBytes: { largestAccepted: number | null; smallestRejected: number | null; rejected: number[] };
  recommendedMaxRequestBytes: number | null; model: string | null;
  /** how the run ended: done, or paused with its reason (cap_reached: the spend limit) */
  state: string; pauseReason: string | null;
}
export interface MeasureDeps {
  decider: Decider;
  apiKey: string;
  /** the owner reviewed the preview: a copy with no record of the payload being seen may still be measured */
  payloadApproved?: boolean;
}

/** Mean, median and 95th percentile (nearest rank) of a list; 0 for an empty one. */
export function stats(values: number[]): { mean: number; median: number; p95: number; max: number } {
  if (values.length === 0) return { mean: 0, median: 0, p95: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
  const p95 = s[Math.max(0, Math.ceil(0.95 * n) - 1)]!;
  return { mean, median, p95, max: s[n - 1]! };
}

export async function measure(ctx: WorkerContext, opts: MeasureOptions, deps: MeasureDeps): Promise<MeasureReport> {
  const [row] = await ctx.sql<Array<{ id: string }>>`
    insert into decider_runs (library_id, decider_id, spec_hash, model_requested, population, seed)
    values (${opts.libraryId}, ${deps.decider.id}, ${jevSpecHash()}, ${opts.model}, ${POPULATION}, ${randomInt(0, 2_147_483_647)})
    returning id`;
  const runId = row!.id;
  // The whole run in this one call: no time budget and no abort signal, so
  // the job never hands the rest of the run to a queue (there is no worker
  // on a restored copy, and nothing should be queued from here).
  const summary = await deciderRunJob(ctx, { runId }, {
    decider: deps.decider, apiKey: deps.apiKey, price: opts.price, maxSpend: opts.maxSpend,
    population: { sample: opts.sample, largest: opts.largest },
    ...(deps.payloadApproved !== undefined ? { payloadApproved: deps.payloadApproved } : {}),
    timeBudgetMs: Number.POSITIVE_INFINITY,
  });
  if (summary.state === 'running') throw new Error('the measurement run is being worked by another process');
  return reportFor(ctx, runId, opts.libraryId, opts.price.currency);
}

/** The report of a measure run, from its own calls and decisions. */
export async function reportFor(ctx: WorkerContext, runId: string, libraryId: string, currency: string): Promise<MeasureReport> {
  const [run] = await ctx.sql<Array<{ decider_version: string | null; state: string; pause_reason: string | null }>>`
    select decider_version, state, pause_reason from decider_runs where id = ${runId}`;
  const calls = await ctx.sql<Array<{ input_tokens: number; cost: string; possibly_billed: boolean }>>`
    select input_tokens, cost::text as cost, possibly_billed from decider_calls where run_id = ${runId}`;
  const decisions = await ctx.sql<Array<{ outcome: string; request_bytes: number | null; call_id: string | null; own_call: boolean }>>`
    select d.outcome, d.request_bytes, d.call_id,
           coalesce((select c.run_id = d.run_id from decider_calls c where c.id = d.call_id), false) as own_call
      from decider_decisions d where d.run_id = ${runId}`;

  // a call with no answer may still be on the bill: spent counts it, the per-album figures do not
  const billed = calls.filter((c) => !c.possibly_billed);
  const tokens = stats(billed.map((c) => Number(c.input_tokens)));
  const cost = stats(billed.map((c) => Number(c.cost)));
  const spent = Math.round(calls.reduce((a, c) => a + Number(c.cost) * 1e6, 0)) / 1e6;

  const outcomes: Record<string, number> = {};
  for (const d of decisions) outcomes[d.outcome] = (outcomes[d.outcome] ?? 0) + 1;
  // a request went out (or a stored answer stood in for it)
  const sent = decisions.filter((d) => d.call_id !== null || d.outcome === 'rejected');
  const reused = decisions.filter((d) => d.call_id !== null && !d.own_call).length;
  const accepted = decisions.filter((d) => d.call_id !== null && d.request_bytes !== null).map((d) => Number(d.request_bytes));
  const rejected = decisions.filter((d) => d.outcome === 'rejected' && d.request_bytes !== null).map((d) => Number(d.request_bytes)).sort((a, b) => a - b);
  const largestAccepted = accepted.length === 0 ? null : accepted.reduce((a, b) => Math.max(a, b));
  const smallestRejected = rejected.length === 0 ? null : rejected[0]!;

  // the queues a real run would send, by decider.run's own population rules
  const needsReview = (await populationAlbumIds(ctx.sql, libraryId, 'needs_review')).length;
  const weak = (await populationAlbumIds(ctx.sql, libraryId, 'weak')).length;
  return {
    runId, albumsSent: sent.length, reused, outcomes,
    inputTokens: tokens, costPerAlbum: { mean: cost.mean, median: cost.median, p95: cost.p95 }, currency, spent,
    queue: { needsReview, weak }, projected: { needsReview: cost.mean * needsReview, withWeak: cost.mean * (needsReview + weak) },
    requestBytes: { largestAccepted, smallestRejected, rejected },
    recommendedMaxRequestBytes: smallestRejected === null ? null : smallestRejected - 1,
    model: run?.decider_version ?? null, state: run?.state ?? 'cancelled', pauseReason: run?.pause_reason ?? null,
  };
}

/**
 * One album's request as a measurement sends it, built by requestForAlbum
 * with the measure population's options and the library's byte limit, as
 * decider.run builds it. A named album must be one a measurement can send
 * (in review, sendable); null otherwise. Without one: the first album that
 * every measurement includes (the largest in review), then the rest of the
 * queue; null when none can be sent.
 */
export async function previewOne(ctx: WorkerContext, libraryId: string, model: string, albumId?: string): Promise<{ albumId: string; bytes: number; request: JevRequest } | null> {
  const config = await autotaggerConfig(ctx.sql, libraryId);
  const build = (ev: NonNullable<Awaited<ReturnType<typeof loadEvidence>>>) => {
    const built = requestForAlbum(ev.album, ev.candidates, requestOptions(POPULATION, { model, maxRequestBytes: config.maxRequestBytes }, ev));
    return { albumId: ev.albumId, bytes: built.bytes, request: built.request };
  };
  if (albumId !== undefined) {
    if (!UUID.test(albumId)) return null;
    // the measure population is drawn from the review queue
    if ((await albumPopulation(ctx.sql, libraryId, albumId)) !== 'needs_review') return null;
    const ev = await ctx.sql.begin('isolation level repeatable read read only', (tx) => loadEvidence(tx, albumId));
    if (!ev) return null;
    return build(ev);
  }
  const largest = await populationAlbumIds(ctx.sql, libraryId, POPULATION, { largest: MEASURE_LARGEST, sample: 0 });
  const queue = await populationAlbumIds(ctx.sql, libraryId, 'needs_review');
  const ids = [...new Set([...largest, ...queue])].slice(0, PREVIEW_SCAN_LIMIT);
  for (let i = 0; i < ids.length; i += PREVIEW_CHUNK) {
    const chunk = ids.slice(i, i + PREVIEW_CHUNK);
    const loaded = await ctx.sql.begin('isolation level repeatable read read only', (tx) => loadEvidenceMany(tx, chunk));
    for (const id of chunk) {
      const ev = loaded.get(id);
      if (!ev) continue;
      try {
        return build(ev);
      } catch {
        continue; // not sent by a measurement either
      }
    }
  }
  return null;
}

// ---- command line ----

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const USAGE = [
  'usage: autotaggerMeasure preview --library <id> [--album <id>] [--model jev-latest]',
  '       autotaggerMeasure measure --library <id> --price-per-mtok <n> --currency <XXX> --max-spend <n>',
  '                                 --key-stdin --payload-approved --confirm-database <name>',
  '                                 [--sample 190] [--largest 10] [--model jev-latest] [--json <file>]',
].join('\n');

export type CliCommand =
  | { command: 'preview'; library: string; album?: string; model: string }
  | {
    command: 'measure'; library: string; model: string; sample: number; largest: number; price: Price; maxSpend: number;
    confirmDatabase: string; json?: string;
  };

const VALUE_FLAGS: Record<'preview' | 'measure', string[]> = {
  preview: ['--library', '--album', '--model'],
  measure: ['--library', '--model', '--price-per-mtok', '--currency', '--max-spend', '--sample', '--largest', '--json', '--confirm-database'],
};
const SWITCHES: Record<'preview' | 'measure', string[]> = { preview: [], measure: ['--key-stdin', '--payload-approved'] };

/**
 * The command line, or why it is not valid usage. A message names flags
 * only, never a value given (a key pasted on the command line is not
 * repeated back).
 */
export function parseCliArgs(argv: string[]): CliCommand | { error: string } {
  const [command, ...rest] = argv;
  if (command !== 'preview' && command !== 'measure') return { error: 'unknown command' };
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (SWITCHES[command].includes(flag)) { switches.add(flag); continue; }
    if (!VALUE_FLAGS[command].includes(flag)) return { error: flag.startsWith('--') && flag.length < 40 && /^--[a-z-]+$/.test(flag) ? `unknown flag ${flag}` : 'unknown argument' };
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` };
    values.set(flag, value);
    i += 1;
  }
  const library = values.get('--library');
  if (!library) return { error: '--library is required' };
  if (!UUID.test(library)) return { error: '--library must be a library id' };
  const model = values.get('--model') ?? DEFAULT_MODEL;
  if (!/^[\w.:-]{1,80}$/.test(model)) return { error: '--model is not a model name' };
  if (command === 'preview') {
    const album = values.get('--album');
    if (album !== undefined && !UUID.test(album)) return { error: '--album must be an album id' };
    return { command, library, model, ...(album !== undefined ? { album } : {}) };
  }
  for (const flag of ['--key-stdin', '--payload-approved']) if (!switches.has(flag)) return { error: `${flag} is required` };
  for (const flag of ['--price-per-mtok', '--currency', '--max-spend', '--confirm-database']) if (!values.has(flag)) return { error: `${flag} is required` };
  const positive = (flag: string): number | null => {
    const raw = values.get(flag)!;
    if (!/^\d+(\.\d+)?$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const count = (flag: string, fallback: number): number | null => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    return /^\d{1,6}$/.test(raw) ? Number(raw) : null;
  };
  const perMillionInput = positive('--price-per-mtok');
  if (perMillionInput === null) return { error: '--price-per-mtok must be a positive number' };
  const maxSpend = positive('--max-spend');
  if (maxSpend === null) return { error: '--max-spend must be a positive number' };
  const currency = values.get('--currency')!;
  if (!/^[A-Z]{3}$/.test(currency)) return { error: '--currency must be a three-letter code' };
  const sample = count('--sample', MEASURE_SAMPLE);
  const largest = count('--largest', MEASURE_LARGEST);
  if (sample === null || largest === null) return { error: '--sample and --largest must be whole numbers' };
  if (sample + largest === 0) return { error: '--sample and --largest are both 0' };
  const json = values.get('--json');
  return {
    command, library, model, sample, largest, price: { perMillionInput, currency }, maxSpend,
    confirmDatabase: values.get('--confirm-database')!, ...(json !== undefined ? { json } : {}),
  };
}

/** Remove the key (and any bearer token) from text before it is shown. */
export function scrub(text: string, key: string): string {
  const t = key ? text.split(key).join('[redacted]') : text;
  return t.replace(/bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]');
}

const num = (x: number, digits = 6): string => String(Number(x.toFixed(digits)));

/** The report as the lines the command prints. */
export function renderReport(r: MeasureReport): string {
  const c = r.currency;
  return [
    `albums sent: ${r.albumsSent} (reused: ${r.reused})    outcomes: ${JSON.stringify(r.outcomes)}`,
    `input tokens per album: mean ${num(r.inputTokens.mean, 1)} median ${num(r.inputTokens.median, 1)} p95 ${r.inputTokens.p95} max ${r.inputTokens.max}`,
    `cost per album (${c}): mean ${num(r.costPerAlbum.mean)} median ${num(r.costPerAlbum.median)} p95 ${num(r.costPerAlbum.p95)}    spent: ${num(r.spent)}`,
    `queue: ${r.queue.needsReview} in review, ${r.queue.weak} weak    projected: ${num(r.projected.needsReview, 4)} in review, ${num(r.projected.withWeak, 4)} with weak`,
    `request bytes: largest accepted ${r.requestBytes.largestAccepted ?? '-'}, smallest rejected ${r.requestBytes.smallestRejected ?? '-'}    recommended limit: ${r.recommendedMaxRequestBytes ?? '-'}`,
    `model: ${r.model ?? '-'}`,
    ...(r.state === 'done' ? [] : [`run ${r.state}${r.pauseReason ? `: ${r.pauseReason}` : ''}`]),
  ].join('\n') + '\n';
}

interface Writable { write: (s: string) => unknown }
export interface CliIo {
  stdout: Writable;
  stderr: Writable;
  env: Record<string, string | undefined>;
  /** stdin read to its end; null when it is a terminal (the key is never typed in) */
  readStdin: () => Promise<string | null>;
  /** the decider for a key (tests); Jev at the configured endpoint by default */
  deciderFor?: (apiKey: string) => Decider;
}

/** The context the command runs with; read-only for preview. */
async function cliContext(url: string, readOnly: boolean, stderr: Writable): Promise<{ ctx: WorkerContext; close: () => Promise<void> }> {
  const { db, client } = await makeDb(url, { readOnly });
  // nothing is ever queued from here: there is no worker on a restored copy
  const boss = { send: async () => { throw new Error('the measurement queues nothing'); } } as unknown as PgBoss;
  const logger = pino({ level: 'warn' }, { write: (s: string) => { stderr.write(s); } });
  return { ctx: { db, sql: client, boss, logger }, close: () => client.end({ timeout: 5 }) };
}

/** Runs the command; the exit code (2: not valid usage or refused, 1: failed, 0: a report). */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const cli = parseCliArgs(argv);
  if ('error' in cli) { io.stderr.write(`${cli.error}\n${USAGE}\n`); return 2; }
  const url = io.env['DATABASE_URL'];
  if (!url) { io.stderr.write('DATABASE_URL is required\n'); return 2; }

  if (cli.command === 'preview') {
    const { ctx, close } = await cliContext(url, true, io.stderr);
    try {
      const p = await previewOne(ctx, cli.library, cli.model, cli.album);
      if (!p) { io.stderr.write('no album to show\n'); return 1; }
      io.stdout.write(`album: ${p.albumId}    bytes: ${p.bytes}\n${JSON.stringify(p.request, null, 2)}\n`);
      return 0;
    } catch (err) {
      io.stderr.write(`${err instanceof NotSendableError ? `not sendable: ${err.reason}` : err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    } finally {
      await close();
    }
  }

  const raw = await io.readStdin();
  if (raw === null) { io.stderr.write('--key-stdin: pipe the key on stdin\n'); return 2; }
  const key = raw.trim();
  if (!key) { io.stderr.write('--key-stdin: no key on stdin\n'); return 2; }
  const { ctx, close } = await cliContext(url, false, io.stderr);
  try {
    // the confirmed database, before anything is written
    const [db] = await ctx.sql<Array<{ name: string }>>`select current_database() as name`;
    if (db?.name !== cli.confirmDatabase) {
      io.stderr.write('refused: --confirm-database does not name the database DATABASE_URL points at\n');
      return 2;
    }
    const [lib] = await ctx.sql`select 1 as x from libraries where id = ${cli.library}`;
    if (!lib) { io.stderr.write('refused: no such library in this database\n'); return 2; }
    const decider = io.deciderFor ? io.deciderFor(key) : jevDecider({ apiKey: key, baseUrl: typesafeBaseUrl(), maxRetries: RUN_MAX_RETRIES });
    const r = await measure(ctx, {
      libraryId: cli.library, sample: cli.sample, largest: cli.largest, model: cli.model, price: cli.price, maxSpend: cli.maxSpend,
    }, { decider, apiKey: key, payloadApproved: true });
    io.stdout.write(scrub(renderReport(r), key));
    // statistics only: no key and no request bodies
    if (cli.json) await writeFile(cli.json, scrub(JSON.stringify(r, null, 2), key));
    // the spend limit reached is a result; any other stop is not
    return r.state === 'done' || (r.state === 'paused' && r.pauseReason === 'cap_reached') ? 0 : 1;
  } catch (err) {
    io.stderr.write(`${scrub(err instanceof Error ? err.message : String(err), key)}\n`);
    return 1;
  } finally {
    await close();
  }
}

async function readAll(stream: NodeJS.ReadStream): Promise<string | null> {
  if (stream.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), {
    stdout: process.stdout, stderr: process.stderr, env: process.env, readStdin: () => readAll(process.stdin),
  }).then((code) => { process.exitCode = code; }, (err) => {
    // the key is scrubbed inside runCli; what reaches here is a connection or usage failure
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
