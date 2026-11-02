/**
 * The autotagger module's settings: its switch (the module ledger), the
 * price table, and each library's settings and API key.
 *
 *   GET    /api/v1/settings/autotagger                      system.manage: the Settings › Modules row
 *   PUT    /api/v1/settings/autotagger                      system.manage + fresh step-up: { enabled }
 *   POST   /api/v1/settings/autotagger/remove-data          system.manage + fresh step-up: turn it off, delete its rows
 *   PUT    /api/v1/settings/autotagger/prices               system.manage: { model, perMillionInput, currency }
 *   DELETE /api/v1/settings/autotagger/prices/:model        system.manage
 *   GET    /api/v1/libraries/:libraryId/autotagger          library.edit: the library's settings (the key's hint for the owner only)
 *   PATCH  /api/v1/libraries/:libraryId/autotagger/config   system.manage: the settings patch
 *   PUT    /api/v1/libraries/:libraryId/autotagger/key      system.manage + fresh step-up: { key } or { key: null }
 *
 * Runs (Library care › Review › Decide with Jev):
 *
 *   GET    /api/v1/libraries/:libraryId/autotagger/preview[?albumId=]   system.manage: the exact request one album's run sends
 *   POST   /api/v1/libraries/:libraryId/autotagger/preview/seen        system.manage: the owner saw it (needed before any run)
 *   POST   /api/v1/libraries/:libraryId/autotagger/runs                system.manage: { population } → 202, the run queued
 *   GET    /api/v1/libraries/:libraryId/autotagger/runs                library.edit: the 20 newest
 *   GET    /api/v1/libraries/:libraryId/autotagger/runs/:runId         library.edit
 *   POST   /api/v1/libraries/:libraryId/autotagger/runs/:runId/resume  system.manage: a paused or failed run, where it stopped
 *   POST   /api/v1/libraries/:libraryId/autotagger/runs/:runId/cancel  system.manage
 *   GET    /api/v1/libraries/:libraryId/autotagger/agreement           library.edit: the decider against the owner, per band
 *
 * Spot checks (the gate a band's batch accept goes through):
 *
 *   GET    /api/v1/libraries/:libraryId/autotagger/runs/:runId/bands                library.edit: picks, checks and the bound per band
 *   POST   /api/v1/libraries/:libraryId/autotagger/runs/:runId/spot-checks/draw     library.edit: { band, count? } → { drawn }
 *   GET    /api/v1/libraries/:libraryId/autotagger/runs/:runId/spot-checks          library.edit: ?band=&verdict=pending&limit=25&offset=0
 *   PUT    /api/v1/libraries/:libraryId/autotagger/spot-checks/:checkId             library.edit: { verdict } → 204
 *
 * A backtest is a run like any other ({ population: 'backtest' }), with the
 * same checks. Agreement only informs: nothing accepts by it.
 *
 * Spot checks are drawn at random from all of a band's picks in a finished
 * run, in an order the run's seed fixes, never the same pick twice; no
 * route adds a chosen album. Only correct and wrong verdicts are checks:
 * unsure is counted apart and never counts as a clean one.
 *
 * Off: every /libraries/:libraryId/autotagger route but the GETs of the
 * settings, the runs (their bands and spot checks too) and the agreement,
 * and cancel, answers 409.
 *
 * The preview and the run make an album's request with the same function
 * (requestForAlbum, @tagave/core), from the same evidence and population
 * rules, so the owner sees byte for byte what is sent for that album and
 * model. Runs are only ever started here, by the owner: nothing schedules
 * one. A start or resume is refused with what is missing (the payload not
 * seen, no key, cap or price, a price in another currency than the cap) by
 * the checks the run itself makes, so the route and the run never disagree.
 * The API key is sealed with the app secret before it is stored, and only
 * its last four characters are ever shown; it is never logged, returned or
 * put in an error or the audit log.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import {
  AUTOTAGGER_MODULE_ID, AUTOTAGGER_TABLES, AutotaggerStillOnError, UnknownModuleError, albumPopulation, autotaggerConfig, autotaggerEnabled, backtestAgreement, checkBudget,
  clearTypesafeKey, deciderRunSingletonKey, loadEvidence, loadEvidenceMany, markPayloadSeen, meanCallCost, monthSpendByCurrency, populationAlbumIds, priceFor,
  deciderRunJobWaiting, removeAutotaggerData, staleDeciderRunJobs, waitingDeciderRunJobs, runSpendByCurrency, sendDeciderRun, setAutotaggerConfig, setAutotaggerEnabled, setTypesafeKey, typesafeKeyHint,
  latestBacktestRunId, queueAgreement, typesafeKeyHintOf, type AutotaggerConfig, type LoadedEvidence,
  bandTable, drawSpotChecks, recordVerdict, spotChecks, type SpotCheckRow,
} from '@tagave/db';
import {
  NotSendableError, bandGate, jevSpecHash, requestForAlbum, requestOptions, sealSecret, type AlbumEvidence, type AlbumRequest, type CandidateEvidence,
  type BandId as CoreBandId,
} from '@tagave/core';
import {
  AUTOTAGGER_DECIDER_ID, DEFAULT_AUTOTAGGER_CONFIG, autotaggerConfigPatchSchema, autotaggerKeySchema, autotaggerModuleSchema, deciderLabel, deciderPriceSchema,
  startRunSchema, BAND_IDS, drawSpotChecksSchema, spotCheckQuerySchema, spotCheckVerdictSchema,
  type AgreementView, type AutotaggerLibraryView, type AutotaggerModuleView, type BandId, type BandRow, type DeciderPrice, type PayloadPreview, type Population,
  type RunView, type SpotCheckItem, type SpotCheckVerdictView,
} from '@tagave/shared';
import { labelSummary, mediaSummary } from '../lib/releaseSummary.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { callerCan } from '../permissions/guard.js';
import { requireFreshStepUp } from './stepUp.js';
import { sameSite } from './mcConnections.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Postgres: relation does not exist (the module's migration has not run). */
const UNDEFINED_TABLE = '42P01';

const sql = () => getAuthHandle().sql;

/** The read's answer, or `fallback` when the module's tables are not there. */
async function orMissing<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return fallback;
    throw err;
  }
}

/** A 400 naming the fields that failed, never the values sent. */
function badRequest(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>, fallback: string): ApiError {
  const first = issues[0];
  return new ApiError(400, 'Bad Request', first ? `${first.path.map(String).join('.') || 'body'}: ${first.message}` : fallback);
}

async function assertLibrary(libraryId: string): Promise<void> {
  if (!UUID.test(libraryId)) throw new ApiError(404, 'Not Found', 'Library not found');
  const [row] = await sql()`select 1 as x from libraries where id = ${libraryId}`;
  if (!row) throw new ApiError(404, 'Not Found', 'Library not found');
}

async function on(): Promise<void> {
  if (!(await autotaggerEnabled(sql()))) throw new ApiError(409, 'Conflict', 'Autotagger is off');
}

/**
 * Run `write` in one transaction with the module's switch row share-locked
 * and on: deleting its data locks the row for update, so it cannot run
 * between the check and the write. Off (or no row): 409.
 */
async function whileOn<T>(write: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql().begin(async (tx) => {
    const [row] = await orMissing(
      () => tx<Array<{ enabled: boolean }>>`select enabled from installed_modules where id = ${AUTOTAGGER_MODULE_ID} for share`,
      [] as Array<{ enabled: boolean }>,
    );
    if (row?.enabled !== true) throw new ApiError(409, 'Conflict', 'Autotagger is off');
    return write(tx);
  }) as Promise<T>;
}

/** How many of the module's tables this database has. */
async function tablesPresent(): Promise<number> {
  const [r] = await sql()<Array<{ n: number }>>`
    select count(*)::int as n from unnest(${[...AUTOTAGGER_TABLES]}::text[]) as t(name) where to_regclass(t.name) is not null`;
  return r!.n;
}

async function prices(): Promise<DeciderPrice[]> {
  return orMissing(async () => {
    const rows = await sql()<Array<{ model: string; per_million_input: string; currency: string }>>`
      select model, per_million_input::text, currency from decider_prices where decider_id = ${AUTOTAGGER_DECIDER_ID} order by model`;
    return rows.map((r) => ({ model: r.model, perMillionInput: Number(r.per_million_input), currency: r.currency }));
  }, []);
}

async function count(table: 'decider_runs' | 'decider_decisions'): Promise<number> {
  return orMissing(async () => {
    const [r] = await sql()<Array<{ n: number }>>`select count(*)::int as n from ${sql()(table)}`;
    return r!.n;
  }, 0);
}

async function moduleView(): Promise<AutotaggerModuleView> {
  return { enabled: await autotaggerEnabled(sql()), runs: await count('decider_runs'), decisions: await count('decider_decisions'), prices: await prices() };
}

async function libraryView(request: FastifyRequest, libraryId: string): Promise<AutotaggerLibraryView> {
  const config = await orMissing(() => autotaggerConfig(sql(), libraryId), { ...DEFAULT_AUTOTAGGER_CONFIG });
  const hint = await orMissing(() => typesafeKeyHint(sql(), libraryId), null);
  // this calendar month (UTC), per currency: the settings' currency, and any other apart
  const spent = await monthSpendByCurrency(sql(), libraryId);
  const owner = callerCan(request, 'system.manage');
  return {
    enabled: await autotaggerEnabled(sql()),
    keySet: hint !== null,
    keyHint: owner ? hint : null,
    config: owner ? config : { ...config, payloadSeenBy: null },
    spentThisMonth: spent.find((s) => s.currency === config.currency)?.amount ?? 0,
    spentOther: spent.filter((s) => s.currency !== config.currency),
    currency: config.currency,
  };
}

// ---- runs and the payload preview ----

/** Runs listed per library, newest first. */
const RUN_LIST_LIMIT = 20;
/** Albums the preview looks through for one with two or more groups, in loads of PREVIEW_CHUNK. */
const PREVIEW_SCAN_LIMIT = 1000;
const PREVIEW_CHUNK = 100;
/** A run that can still go on (one per library at a time). */
const ACTIVE_STATES = ['queued', 'running', 'paused'];
/** A run that resume picks up where it stopped. */
const RESUMABLE_STATES = ['paused', 'failed'];

type Loaded = LoadedEvidence<AlbumEvidence, CandidateEvidence>;
type Tx = postgres.TransactionSql;

/**
 * One album's Jev request, exactly as its run would make it: the Jev
 * builder the Jev decider builds with, and the options the run takes from
 * requestOptions too.
 */
function requestFor(ev: Loaded, config: AutotaggerConfig, population: Population): AlbumRequest {
  return requestForAlbum(ev.album, ev.candidates, requestOptions(population, config, ev));
}

function previewOf(ev: Loaded, built: AlbumRequest): PayloadPreview {
  return { albumId: ev.albumId, title: ev.album.title, artist: ev.album.artist, bytes: built.bytes, groups: built.sent.length, request: built.request };
}

/** Why an album is not sent, as a label (never the album's data). */
function notSendable(err: unknown): ApiError {
  const reason = err instanceof NotSendableError ? err.reason : 'invalid_evidence';
  return new ApiError(409, 'Conflict', `Not sendable: ${reason}`);
}

/** The album asked for: in the library and in a run's population, built as that run builds it. */
async function previewOfAlbum(libraryId: string, albumId: string, config: AutotaggerConfig): Promise<PayloadPreview> {
  if (!UUID.test(albumId)) throw new ApiError(404, 'Not Found', 'Album not found');
  const [album] = await sql()`select 1 as x from local_albums where id = ${albumId} and library_id = ${libraryId}`;
  if (!album) throw new ApiError(404, 'Not Found', 'Album not found');
  const population = await albumPopulation(sql(), libraryId, albumId);
  if (!population) throw new ApiError(409, 'Conflict', 'Not sendable: population');
  // one snapshot, as the run loads it
  const ev = await sql().begin('isolation level repeatable read read only', (tx) => loadEvidence<AlbumEvidence, CandidateEvidence>(tx, albumId));
  if (!ev) throw new ApiError(409, 'Conflict', 'Not sendable: no_evidence');
  try {
    return previewOf(ev, requestFor(ev, config, population));
  } catch (err) {
    throw notSendable(err);
  }
}

/**
 * The first album in review (by id) whose request has two or more groups,
 * else the first with one; looked for among the first PREVIEW_SCAN_LIMIT.
 * Null when there is none.
 */
async function firstPreview(libraryId: string, config: AutotaggerConfig): Promise<PayloadPreview | null> {
  const ids = (await populationAlbumIds(sql(), libraryId, 'needs_review')).slice(0, PREVIEW_SCAN_LIMIT);
  let single: PayloadPreview | null = null;
  for (let i = 0; i < ids.length; i += PREVIEW_CHUNK) {
    const chunk = ids.slice(i, i + PREVIEW_CHUNK);
    const loaded = await sql().begin('isolation level repeatable read read only', (tx) => loadEvidenceMany<AlbumEvidence, CandidateEvidence>(tx, chunk));
    for (const id of chunk) {
      const ev = loaded.get(id);
      if (!ev) continue;
      let built: AlbumRequest;
      try {
        built = requestFor(ev, config, 'needs_review');
      } catch {
        continue; // not sent by a run either
      }
      if (built.sent.length >= 2) return previewOf(ev, built);
      single ??= previewOf(ev, built);
    }
  }
  return single;
}

interface RunRow {
  id: string; population: Population; state: string; pause_reason: string | null; message: string | null; decider_version: string | null;
  model_requested: string; seed: number; created_at: string | Date; started_by: string | null;
}

async function runRows(libraryId: string, runId?: string): Promise<RunRow[]> {
  const one = runId ?? null;
  return orMissing(() => sql()<RunRow[]>`
    select r.id, r.population, r.state, r.pause_reason, r.message, r.decider_version, r.model_requested, r.seed, r.created_at,
           u.display_name as started_by
      from decider_runs r
      left join users u on u.id = r.started_by_user_id
     where r.library_id = ${libraryId} and (${one}::uuid is null or r.id = ${one}::uuid)
     order by r.created_at desc, r.id desc
     limit ${RUN_LIST_LIMIT}`, [] as RunRow[]);
}

async function runViews(libraryId: string, rows: RunRow[]): Promise<RunView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const counts = await sql()<Array<{ run_id: string; outcome: string; n: number }>>`
    select run_id, outcome, count(*)::int as n from decider_decisions where run_id = any(${ids}::uuid[]) group by run_id, outcome`;
  const outcomes = new Map<string, Record<string, number>>();
  for (const c of counts) outcomes.set(c.run_id, { ...(outcomes.get(c.run_id) ?? {}), [c.outcome]: c.n });
  const config = await autotaggerConfig(sql(), libraryId);
  const spend = await runSpendByCurrency(sql(), ids);
  const mean = await meanCallCost(sql(), libraryId, config.currency);
  const views: RunView[] = [];
  for (const r of rows) {
    const o = outcomes.get(r.id) ?? {};
    // a run that can go on covers its population as it is now; one that ended, the albums it decided
    const albums = ACTIVE_STATES.includes(r.state)
      ? (await populationAlbumIds(sql(), libraryId, r.population, { seed: r.seed })).length
      : Object.values(o).reduce((a, b) => a + b, 0);
    views.push({
      id: r.id,
      population: r.population,
      state: r.state,
      pauseReason: r.pause_reason,
      message: r.message,
      modelLabel: deciderLabel(AUTOTAGGER_DECIDER_ID, r.decider_version ?? r.model_requested),
      createdAt: new Date(r.created_at).toISOString(),
      startedBy: r.started_by,
      albums,
      outcomes: o,
      // only the settings' currency: amounts in different currencies are never added
      spent: spend.get(r.id)?.find((s) => s.currency === config.currency)?.amount ?? 0,
      spentOther: spend.get(r.id)?.filter((s) => s.currency !== config.currency) ?? [],
      currency: config.currency,
      projected: mean === null ? null : Math.round(albums * mean * 1e6) / 1e6,
    });
  }
  return views;
}

async function runView(libraryId: string, runId: string): Promise<RunView> {
  if (!UUID.test(runId)) throw new ApiError(404, 'Not Found', 'Run not found');
  const [view] = await runViews(libraryId, await runRows(libraryId, runId));
  if (!view) throw new ApiError(404, 'Not Found', 'Run not found');
  return view;
}

/**
 * What a run needs before it may go: the API key, the payload seen, and
 * (except the measurement, which keeps its own limit) a cap and a price
 * for `model` in the cap's currency, checked as the run checks them before
 * each call; and no other run of the library that can still go on. 409
 * naming what is missing.
 */
async function refuseUnlessReady(tx: Tx, libraryId: string, population: Population, model: string, exceptRun: string | null): Promise<void> {
  if ((await typesafeKeyHint(tx, libraryId)) === null) throw new ApiError(409, 'Conflict', 'No TypeSafe key');
  const config = await autotaggerConfig(tx, libraryId);
  if (!config.payloadSeenAt) throw new ApiError(409, 'Conflict', 'See the payload first');
  if (population !== 'measure') {
    const price = await priceFor(tx, AUTOTAGGER_DECIDER_ID, model);
    const verdict = await checkBudget(tx, { libraryId, cap: config.monthlyCap, currency: config.currency, price, estimate: 0 });
    if (!verdict.ok) {
      if (verdict.reason === 'no_cap') throw new ApiError(409, 'Conflict', 'No monthly cap');
      if (verdict.reason === 'no_price') throw new ApiError(409, 'Conflict', `No price: ${model}`);
      if (verdict.reason === 'currency_mismatch') throw new ApiError(409, 'Conflict', `Price ${price!.currency}, cap ${config.currency}`);
      throw new ApiError(409, 'Conflict', `Cap reached: ${verdict.spent.toFixed(4)} of ${verdict.cap} ${config.currency}`);
    }
  }
  const [active] = await tx<Array<{ id: string }>>`
    select id from decider_runs
     where library_id = ${libraryId} and state = any(${ACTIVE_STATES}::text[]) and (${exceptRun}::uuid is null or id <> ${exceptRun}::uuid)
     limit 1`;
  if (active) throw new ApiError(409, 'Conflict', 'A run is active');
}

/** One start or resume of the library's runs at a time (until the transaction ends). */
async function lockLibraryRuns(tx: Tx, libraryId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${deciderRunSingletonKey(libraryId)}))`;
}

/**
 * Queue the run's job. pg-boss keeps one waiting job per library. When it
 * keeps another instead of this one: fine if the waiting job is this run's;
 * a waiting job of a run that can no longer go on (cancelled or ended) is
 * cancelled and the send tried again; otherwise nothing would ever work
 * the run, so `undo` puts it back and the caller gets a 503.
 */
async function queueRun(libraryId: string, runId: string, undo: () => Promise<unknown>, log: FastifyRequest['log']): Promise<void> {
  try {
    const boss = await getBoss();
    if (await sendDeciderRun(boss, libraryId, runId)) return;
    if (await deciderRunJobWaiting(sql(), libraryId, runId)) return;
    const stale = await staleDeciderRunJobs(sql(), libraryId);
    if (stale.length > 0) {
      await boss.cancel('decider.run', stale);
      if (await sendDeciderRun(boss, libraryId, runId)) return;
    }
  } catch (err) {
    log.error({ err, event: 'autotagger.run_not_queued', libraryId, runId }, 'decider run not queued');
  }
  await undo();
  throw new ApiError(503, 'Service Unavailable', 'Run not queued; retry');
}

/** The run's state, or a 404 when the library has no such run (a cheap check before any work). */
async function runStateOf(libraryId: string, runId: string): Promise<string> {
  if (!UUID.test(runId)) throw new ApiError(404, 'Not Found', 'Run not found');
  const [row] = await orMissing(
    () => sql()<Array<{ state: string }>>`select state from decider_runs where id = ${runId} and library_id = ${libraryId}`,
    [] as Array<{ state: string }>,
  );
  if (!row) throw new ApiError(404, 'Not Found', 'Run not found');
  return row.state;
}

// ---- spot checks ----

/** The bands @tagave/shared names are the decider's own (a compile error otherwise). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const BANDS_AGREE: Same<CoreBandId, BandId> = true;
void BANDS_AGREE;

const isBand = (b: string): b is BandId => (BAND_IDS as readonly string[]).includes(b);

/**
 * The run's bands against the spot-check gate: the 95% Clopper-Pearson
 * bound from its wrong verdicts among correct and wrong ones (unsure
 * never counts), at most `maxRate` to be allowed. A missing module table
 * reads as no bands.
 */
export async function gatedBands(db: postgres.Sql<any> | Tx, runId: string, maxRate: number): Promise<BandRow[]> {
  const rows = await bandTable(db, runId);
  return rows.filter((r) => isBand(r.band)).map((r) => {
    const gate = bandGate(r.errors, r.checked, maxRate);
    return {
      band: r.band as BandId, picks: r.picks, drawn: r.drawn, checked: r.checked, errors: r.errors, unsure: r.unsure,
      upper: gate.upper, allowed: gate.allowed,
      // out of reach within the bound's search limit: JSON has no Infinity
      stillNeeded: Number.isFinite(gate.stillNeeded) ? gate.stillNeeded : null,
      accepted: r.accepted,
    };
  });
}

/** Whole seconds as m:ss (h:mm:ss from an hour); null when unknown. */
function lengthOf(seconds: number | null): string | null {
  if (seconds === null || !(seconds > 0)) return null;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function spotCheckItem(r: SpotCheckRow): SpotCheckItem {
  const year = r.releaseDate ? Number.parseInt(r.releaseDate.slice(0, 4), 10) : NaN;
  return {
    id: r.id,
    band: r.band as BandId,
    verdict: r.verdict as SpotCheckVerdictView,
    album: {
      id: r.albumId, title: r.albumTitle, artist: r.albumArtist, year: r.albumYear,
      tracks: r.albumTracks.map((t, i) => ({ n: i + 1, title: t.title, length: lengthOf(t.seconds) })),
    },
    chosen: {
      releaseId: r.releaseId,
      title: r.releaseTitle ?? '',
      year: Number.isFinite(year) ? year : null,
      country: r.releaseCountry,
      label: labelSummary(r.releaseLabels),
      format: mediaSummary(r.releaseMedia),
      source: r.releaseSource ?? '',
      tracks: r.releaseTracks.map((t, i) => ({ n: i + 1, title: t.title ?? '', length: lengthOf(t.seconds) })),
    },
    probability: r.probability ?? 0,
    groupSize: r.groupSize,
  };
}

export async function createAutotaggerRoutes(fastify: FastifyInstance) {
  // ---- Settings › Modules ----

  fastify.get('/settings/autotagger', async (): Promise<AutotaggerModuleView> => moduleView());

  fastify.put('/settings/autotagger', async (request): Promise<AutotaggerModuleView> => {
    sameSite(request);
    const parsed = autotaggerModuleSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'enabled (true or false) is required');
    await requireFreshStepUp(request);
    try {
      await setAutotaggerEnabled(sql(), parsed.data.enabled);
    } catch (err) {
      if (err instanceof UnknownModuleError) throw new ApiError(409, 'Conflict', 'Autotagger is not installed');
      throw err;
    }
    request.log.info({ event: parsed.data.enabled ? 'module.enable' : 'module.disable', module: 'autotagger', userId: request.user?.id }, 'autotagger switched');
    return moduleView();
  });

  fastify.post('/settings/autotagger/remove-data', async (request, reply) => {
    sameSite(request);
    await requireFreshStepUp(request);
    const actor = request.user?.id ?? null;
    // off first, so no run starts while the rows go; the delete checks again,
    // with the switch's row locked, and refuses if it was turned back on
    try {
      await setAutotaggerEnabled(sql(), false);
    } catch (err) {
      // no ledger row: it was never on
      if (!(err instanceof UnknownModuleError)) throw err;
    }
    // the switch is recorded before the delete, so a failed delete still leaves the trail
    await sql()`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
              values (null, ${actor}, 'module.disable', 'module', ${JSON.stringify({ module: 'autotagger', for: 'remove_data' })}::text::jsonb)`;
    request.log.info({ event: 'module.disable', module: 'autotagger', userId: actor, for: 'remove_data' }, 'autotagger switched off to delete its data');
    let removed: Record<string, number>;
    try {
      // no table at all: never migrated, nothing to delete; some missing: an error
      removed = (await tablesPresent()) === 0 ? {} : await removeAutotaggerData(sql());
    } catch (err) {
      if (err instanceof AutotaggerStillOnError) throw new ApiError(409, 'Conflict', 'Autotagger was turned on again');
      request.log.error({ err, event: 'module.remove_data_failed', module: 'autotagger', userId: actor }, 'autotagger data not removed');
      // off, nothing deleted (one transaction), and a retry is safe
      return reply.status(500).send({ title: 'Data not removed', status: 500, detail: 'Autotagger: off · data: kept · retry: safe', enabled: false, removed: null });
    }
    await sql()`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
              values (null, ${request.user?.id ?? null}, 'module.remove_data', 'module', ${JSON.stringify({ module: 'autotagger', ...removed })}::text::jsonb)`;
    request.log.info({ event: 'module.remove_data', module: 'autotagger', userId: actor, ...removed }, 'autotagger data removed');
    const view: AutotaggerModuleView & { removed: Record<string, number> } = { ...(await moduleView()), removed };
    return view;
  });

  fastify.put('/settings/autotagger/prices', async (request): Promise<AutotaggerModuleView> => {
    sameSite(request);
    const parsed = deciderPriceSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues, 'Invalid price');
    const p = parsed.data;
    await sql()`
      insert into decider_prices (decider_id, model, per_million_input, currency)
      values (${AUTOTAGGER_DECIDER_ID}, ${p.model}, ${p.perMillionInput}, ${p.currency})
      on conflict (decider_id, model) do update
        set per_million_input = excluded.per_million_input, currency = excluded.currency, updated_at = now()`;
    return moduleView();
  });

  fastify.delete('/settings/autotagger/prices/:model', async (request): Promise<AutotaggerModuleView> => {
    sameSite(request);
    const { model } = request.params as { model: string };
    const valid = deciderPriceSchema.shape.model.safeParse(model);
    if (!valid.success) throw new ApiError(404, 'Not Found', 'Price not found');
    const gone = await sql()`delete from decider_prices where decider_id = ${AUTOTAGGER_DECIDER_ID} and model = ${valid.data}`;
    if (gone.count === 0) throw new ApiError(404, 'Not Found', 'Price not found');
    return moduleView();
  });

  // ---- one library ----

  fastify.get('/libraries/:libraryId/autotagger', async (request): Promise<AutotaggerLibraryView> => {
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(libraryId);
    return libraryView(request, libraryId);
  });

  fastify.patch('/libraries/:libraryId/autotagger/config', async (request): Promise<AutotaggerLibraryView> => {
    sameSite(request);
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(libraryId);
    await on();
    const parsed = autotaggerConfigPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues, 'Invalid settings');
    await whileOn((tx) => setAutotaggerConfig(tx, libraryId, parsed.data, (raw) => autotaggerConfigPatchSchema.parse(raw)));
    return libraryView(request, libraryId);
  });

  fastify.put('/libraries/:libraryId/autotagger/key', async (request): Promise<AutotaggerLibraryView> => {
    sameSite(request);
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(libraryId);
    await on();
    const parsed = autotaggerKeySchema.safeParse(request.body ?? {});
    // the message never carries what was sent
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'key: 16 to 512 characters, no spaces, or null');
    await requireFreshStepUp(request);
    const plain = parsed.data.key;
    const actor = request.user?.id ?? null;
    const appSecret = process.env.APP_SECRET;
    if (plain !== null && !appSecret) throw new ApiError(503, 'Service Unavailable', 'APP_SECRET is not set');
    // the audit row names the library and who; never the key or its hint
    const action = plain === null ? 'autotagger.key_cleared' : 'autotagger.key_set';
    await whileOn(async (tx) => {
      if (plain === null) await clearTypesafeKey(tx, libraryId);
      else await setTypesafeKey(tx, libraryId, sealSecret(plain, appSecret!), typesafeKeyHintOf(plain));
      await tx`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id)
               values (${libraryId}, ${actor}, ${action}, 'library', ${libraryId})`;
    });
    request.log.info({ event: action, libraryId, userId: actor }, plain === null ? 'autotagger key cleared' : 'autotagger key set');
    return libraryView(request, libraryId);
  });

  // ---- runs and the payload preview ----

  fastify.get('/libraries/:libraryId/autotagger/preview', async (request): Promise<PayloadPreview> => {
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(libraryId);
    await on();
    const { albumId } = (request.query ?? {}) as { albumId?: string };
    const config = await autotaggerConfig(sql(), libraryId);
    if (albumId !== undefined) return previewOfAlbum(libraryId, albumId, config);
    const preview = await firstPreview(libraryId, config);
    if (!preview) throw new ApiError(404, 'Not Found', 'No album to show');
    return preview;
  });

  fastify.post('/libraries/:libraryId/autotagger/preview/seen', async (request): Promise<AutotaggerLibraryView> => {
    sameSite(request);
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(libraryId);
    await on();
    const actor = request.user?.id;
    if (!actor) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    // the audit row names the library and who; never the payload
    await whileOn(async (tx) => {
      await markPayloadSeen(tx, libraryId, actor);
      await tx`insert into audit_log (library_id, actor_user_id, action, subject_type, subject_id)
               values (${libraryId}, ${actor}, 'autotagger.payload_seen', 'library', ${libraryId})`;
    });
    request.log.info({ event: 'autotagger.payload_seen', libraryId, userId: actor }, 'autotagger payload seen');
    return libraryView(request, libraryId);
  });

  fastify.post('/libraries/:libraryId/autotagger/runs', async (request, reply): Promise<RunView> => {
    sameSite(request);
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(libraryId);
    const parsed = startRunSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'population: needs_review, weak or backtest');
    await on();
    const { population } = parsed.data;
    const actor = request.user?.id ?? null;
    const runId = await whileOn(async (tx) => {
      await lockLibraryRuns(tx, libraryId);
      const config = await autotaggerConfig(tx, libraryId);
      await refuseUnlessReady(tx, libraryId, population, config.model, null);
      const [row] = await tx<Array<{ id: string }>>`
        insert into decider_runs (library_id, decider_id, spec_hash, model_requested, population, started_by_user_id)
        values (${libraryId}, ${AUTOTAGGER_DECIDER_ID}, ${jevSpecHash()}, ${config.model}, ${population}, ${actor})
        returning id`;
      return row!.id;
    });
    await queueRun(libraryId, runId, () => sql()`
      update decider_runs set state = 'failed', message = 'not queued', finished_at = now() where id = ${runId} and state = 'queued'`, request.log);
    request.log.info({ event: 'autotagger.run_started', libraryId, runId, population, userId: actor }, 'decider run queued');
    reply.status(202);
    return runView(libraryId, runId);
  });

  fastify.get('/libraries/:libraryId/autotagger/runs', async (request): Promise<{ items: RunView[] }> => {
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(libraryId);
    return { items: await runViews(libraryId, await runRows(libraryId)) };
  });

  fastify.get('/libraries/:libraryId/autotagger/runs/:runId', async (request): Promise<RunView> => {
    const { libraryId, runId } = request.params as { libraryId: string; runId: string };
    await assertLibrary(libraryId);
    return runView(libraryId, runId);
  });

  fastify.get('/libraries/:libraryId/autotagger/agreement', async (request): Promise<AgreementView> => {
    const { libraryId } = request.params as { libraryId: string };
    await assertLibrary(libraryId);
    // separate reads, no transaction: a missing module table reads as empty
    const runId = await latestBacktestRunId(sql(), libraryId);
    const backtest = runId ? { runId, rows: await backtestAgreement(sql(), runId) } : null;
    return { backtest, queue: await queueAgreement(sql(), libraryId) };
  });

  // ---- spot checks ----

  fastify.get('/libraries/:libraryId/autotagger/runs/:runId/bands', async (request): Promise<BandRow[]> => {
    const { libraryId, runId } = request.params as { libraryId: string; runId: string };
    await assertLibrary(libraryId);
    await runStateOf(libraryId, runId);
    const config = await orMissing(() => autotaggerConfig(sql(), libraryId), { ...DEFAULT_AUTOTAGGER_CONFIG });
    return gatedBands(sql(), runId, config.maxErrorRate);
  });

  fastify.post('/libraries/:libraryId/autotagger/runs/:runId/spot-checks/draw', async (request): Promise<{ drawn: number }> => {
    sameSite(request);
    const { libraryId, runId } = request.params as { libraryId: string; runId: string };
    await assertLibrary(libraryId);
    await runStateOf(libraryId, runId);
    const parsed = drawSpotChecksSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues, 'band (p99, p97, p95 or p90) and count (1 to 100)');
    await on();
    const { band, count } = parsed.data;
    const ids = await whileOn(async (tx) => {
      // the sample is drawn from all of the band's picks: only once the run has decided them all
      const [run] = await tx<Array<{ state: string }>>`select state from decider_runs where id = ${runId} and library_id = ${libraryId}`;
      if (!run) throw new ApiError(404, 'Not Found', 'Run not found');
      if (run.state !== 'done') throw new ApiError(409, 'Conflict', `Run is ${run.state}`);
      return drawSpotChecks(tx, runId, band, count);
    });
    request.log.info({ event: 'autotagger.spot_checks_drawn', libraryId, runId, band, drawn: ids.length, userId: request.user?.id ?? null }, 'spot checks drawn');
    return { drawn: ids.length };
  });

  fastify.get('/libraries/:libraryId/autotagger/runs/:runId/spot-checks', async (request): Promise<SpotCheckItem[]> => {
    const { libraryId, runId } = request.params as { libraryId: string; runId: string };
    await assertLibrary(libraryId);
    await runStateOf(libraryId, runId);
    const parsed = spotCheckQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues, 'Invalid filter');
    const rows = await spotChecks(sql(), runId, parsed.data);
    return rows.map(spotCheckItem);
  });

  fastify.put('/libraries/:libraryId/autotagger/spot-checks/:checkId', async (request, reply) => {
    sameSite(request);
    const { libraryId, checkId } = request.params as { libraryId: string; checkId: string };
    await assertLibrary(libraryId);
    if (!UUID.test(checkId)) throw new ApiError(404, 'Not Found', 'Spot check not found');
    const parsed = spotCheckVerdictSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'verdict: correct, wrong or unsure');
    await on();
    const actor = request.user?.id;
    if (!actor) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const found = await whileOn((tx) => recordVerdict(tx, checkId, parsed.data.verdict, actor, libraryId));
    if (!found) throw new ApiError(404, 'Not Found', 'Spot check not found');
    request.log.info({ event: 'autotagger.spot_check_verdict', libraryId, checkId, verdict: parsed.data.verdict, userId: actor }, 'spot check verdict');
    return reply.status(204).send();
  });

  fastify.post('/libraries/:libraryId/autotagger/runs/:runId/resume', async (request, reply): Promise<RunView> => {
    sameSite(request);
    const { libraryId, runId } = request.params as { libraryId: string; runId: string };
    await assertLibrary(libraryId);
    await runStateOf(libraryId, runId);
    await on();
    const prior = await whileOn(async (tx) => {
      await lockLibraryRuns(tx, libraryId);
      const [run] = await tx<Array<{ state: string; population: Population; spec_hash: string; model: string; pause_reason: string | null; message: string | null }>>`
        select state, population, spec_hash, coalesce(decider_version, model_requested) as model, pause_reason, message
          from decider_runs where id = ${runId} and library_id = ${libraryId} for update`;
      if (!run) throw new ApiError(404, 'Not Found', 'Run not found');
      if (!RESUMABLE_STATES.includes(run.state)) throw new ApiError(409, 'Conflict', `Run is ${run.state}`);
      // the run asks the question it started with; a new run asks the new one
      if (run.spec_hash !== jevSpecHash()) throw new ApiError(409, 'Conflict', 'Question changed');
      await refuseUnlessReady(tx, libraryId, run.population, run.model, runId);
      await tx`update decider_runs set state = 'queued', pause_reason = null, message = null, finished_at = null where id = ${runId}`;
      return run;
    });
    // not queued: back as it was, a failed run paused so it can be resumed again
    await queueRun(libraryId, runId, () => sql()`
      update decider_runs set state = 'paused', pause_reason = ${prior.pause_reason ?? 'stopped'}, message = ${prior.pause_reason ? prior.message : 'stopped: not queued again'}
       where id = ${runId} and state = 'queued'`, request.log);
    request.log.info({ event: 'autotagger.run_resumed', libraryId, runId, userId: request.user?.id ?? null }, 'decider run queued again');
    reply.status(202);
    return runView(libraryId, runId);
  });

  fastify.post('/libraries/:libraryId/autotagger/runs/:runId/cancel', async (request): Promise<RunView> => {
    sameSite(request);
    const { libraryId, runId } = request.params as { libraryId: string; runId: string };
    await assertLibrary(libraryId);
    const before = await runStateOf(libraryId, runId);
    // the run's job sees it before its next paid call and stops; off or not, a run can be cancelled
    const moved = await sql()`
      update decider_runs set state = 'cancelled', finished_at = now()
       where id = ${runId} and library_id = ${libraryId} and state = any(${ACTIVE_STATES}::text[])`;
    if (moved.count === 0) throw new ApiError(409, 'Conflict', `Run is ${before}`);
    // its job still waiting would hold the library's one waiting slot: cancelled with it
    const waiting = await waitingDeciderRunJobs(sql(), runId);
    if (waiting.length > 0) {
      try {
        await (await getBoss()).cancel('decider.run', waiting);
      } catch (err) {
        // the next start cancels it (a waiting job of a run that ended)
        request.log.warn({ err, event: 'autotagger.run_job_not_cancelled', libraryId, runId }, 'waiting decider run job not cancelled');
      }
    }
    request.log.info({ event: 'autotagger.run_cancelled', libraryId, runId, userId: request.user?.id ?? null }, 'decider run cancelled');
    return runView(libraryId, runId);
  });
}
