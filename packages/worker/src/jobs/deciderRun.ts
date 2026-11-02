/**
 * decider.run: one owner-started run over a population. Per album: load the
 * evidence (sendable candidates only), group the tracklists, reuse a stored
 * call for the same album, evidence, question spec and dated model, or ask
 * the decider within the monthly cap; then record the decision. The call
 * and the decision are written in one transaction. This job only records
 * decisions: accepting a band is a separate, owner-started batch.
 *
 * The first answer pins the run to the dated model it names; an answer
 * under another model pauses the run (model_changed). The run pauses, with a
 * reason the page shows, when the question spec changed since it started,
 * the module is off, the owner has not seen the payload, there is no key,
 * cap or price, a price is in another
 * currency than the cap, the cap is reached or the key is refused. A pause
 * or a crash resumes where it stopped: albums already decided in the run are
 * skipped, and a stored answer is never paid for twice. A call that got no
 * answer after a server error or a timeout may still have been billed: it is
 * kept as possibly billed, at its estimate, so the cap counts it.
 *
 * A measure run (a measurement on a copy of the library) skips the module
 * switch and the monthly cap and answers to its own price and spend limit
 * instead; it writes decisions and calls only, never matches or batches.
 *
 * One loop per run at a time: the job holds a session advisory lock on the
 * run for the whole loop, on a connection of its own, and a second job for
 * the same run (a pg-boss retry after an expiry that did not stop the
 * first) finds it taken and does nothing. Each job also stops well before
 * its expiry, queues the rest of the run and leaves it running.
 *
 * Albums the decider is never asked about, each recorded with its reason:
 *   no_candidates  no evidence, no sendable candidate, a sendable candidate
 *                  without evidence (partial_evidence: the decider would
 *                  judge part of the set), or an album title that did not
 *                  come from the tags (album_title)
 *   too_large      the request is over the library's byte limit, or a
 *                  tracklist is over the alignment cap (capped)
 * A request the service refuses as it is (400, 413, 422) is `rejected`, and
 * stored evidence that does not hold together is `error` (invalid_evidence);
 * either way the run carries on.
 */
import {
  JEV_SPEC, NotSendableError, decideFromProbabilities, evidenceHash, hashOf, jevSpecHash, pickEdition, requestOptions, rulesFromStored,
  type Decider, type DeciderAnswer, type DeciderRequest, type EvidenceCandidate, type TracklistGroup,
} from '@tagave/core';
import {
  autotaggerConfig, autotaggerEnabled, checkBudget, costOf, deciderRunSingletonKey, fetchAutoAcceptRulesRow, pauseStaleRuns, priceFor,
  tokensPerByte, type Price,
} from '@tagave/db';
import type { Population } from '@tagave/shared';
import type { WorkerContext } from '../lib/context.js';
import { failureReason } from '../lib/batchFailure.js';
import { loadEvidence, type LoadedEvidence } from '../lib/evidenceStore.js';
import { populationAlbumIds } from '../lib/deciderPopulation.js';
import { libraryTypesafeKey } from '../lib/providers.js';
import { jevDecider } from '../lib/jevDecider.js';
import { JevKeyRefused, JevRejected, JevUnavailable, typesafeBaseUrl } from '../lib/jevClient.js';
import { reportProgress } from './progress.js';

/** The groups and editions shown per request (requestForAlbum, @tagave/core). */
export { MAX_EDITIONS_PER_GROUP, MAX_GROUPS } from '@tagave/core';
/**
 * Client retries per call for a run. Every retry after a 5xx or a timeout
 * may be billed without an answer to show for it, so a run allows one.
 */
export const RUN_MAX_RETRIES = 1;
/** How often (in albums) a run looks for a cancel or the module turned off, and reports progress. */
export const CHECK_EVERY = 25;
/**
 * How long one job works a run before it queues the rest and stops: an
 * hour under the job's 6-hour expiry, so pg-boss never fails a job that is
 * still working (its retry would start a second loop beside the first).
 */
export const DECIDER_RUN_TIME_BUDGET_MS = 5 * 3600 * 1000;
/** The advisory lock namespace of a run's loop (the key is the run id's hash). */
export const DECIDER_RUN_LOCK_NAMESPACE = 0x64_72_75_6e; // 'drun'

export interface DeciderRunJobData { runId: string }
export interface RunDeps {
  decider?: Decider;
  apiKey?: string;
  checkEvery?: number;
  /** overrides tokensPerByte() for the cost estimate before each call */
  tokensPerByte?: number;
  /**
   * A measure run only: the price of a call, used instead of the price table.
   * Its currency may differ from the library's: the measurement's own limit
   * (maxSpend) is in this price's currency, and the library's cap and
   * currency are not consulted. Any other population ignores it.
   */
  price?: Price;
  /**
   * A measure run only: the run pauses (cap_reached) before a call that would
   * take this run's own cost, possibly billed calls included, over it.
   * Any other population ignores it.
   */
  maxSpend?: number;
  /**
   * A measure run only: the owner has confirmed the payload preview, so the
   * run may go on when the library has no record of the owner seeing it (a
   * restored copy). Any other population still needs that record.
   */
  payloadApproved?: boolean;
  /** the measure population's mix (sample and largest albums) */
  population?: { sample: number; largest: number };
  /** no retry follows if this run fails (default true: a direct call has none) */
  lastAttempt?: boolean;
  /** pg-boss's signal for the job: aborted, the job stops before its next album */
  signal?: AbortSignal;
  /** how long this job works before it queues the rest (default DECIDER_RUN_TIME_BUDGET_MS) */
  timeBudgetMs?: number;
  /** milliseconds now (tests) */
  clock?: () => number;
}
/** 'running': this job stopped and left the run running (another job carries on, or one already holds it). */
export interface RunSummary { state: 'done' | 'paused' | 'cancelled' | 'running'; pauseReason: string | null; decided: Record<string, number>; reused: number; billed: number }

type PauseReason =
  | 'spec_changed' | 'module_off' | 'no_key' | 'no_cap' | 'no_price' | 'currency_mismatch' | 'cap_reached' | 'key_refused' | 'model_changed'
  | 'stopped' | 'payload_not_seen';

interface RunRow {
  id: string; library_id: string; decider_id: string; population: Population; state: string; model_requested: string;
  decider_version: string | null; spec_hash: string; seed: number;
}

interface DecisionFields {
  outcome: 'pick' | 'none' | 'too_large' | 'no_candidates' | 'rejected' | 'error';
  callId?: string | null; groupLabel?: string | null; groupReleaseIds?: string[]; releaseId?: string | null;
  distance?: number | null; source?: string | null; probability?: number | null; margin?: number | null; band?: string | null;
  reason?: string | null;
}

type Sql = WorkerContext['sql'];
type TxSql = Parameters<Parameters<Sql['begin']>[1]>[0];
type ProgressState = 'running' | 'completed' | 'cancelled' | 'failed';

const f4 = (x: number | null | undefined): string | null => (x === null || x === undefined ? null : x.toFixed(4));
const emptySummary = (): RunSummary => ({ state: 'done', pauseReason: null, decided: {}, reused: 0, billed: 0 });

/**
 * A JevUnavailable after which the call may have been billed: the server
 * failed (5xx), the request timed out or the connection dropped, or the
 * answer came back (2xx) and could not be read.
 */
function maybeBilled(err: JevUnavailable): boolean {
  return err.status === null || err.status >= 500 || (err.status >= 200 && err.status < 300);
}

export async function deciderRunJob(ctx: WorkerContext, data: DeciderRunJobData, deps: RunDeps = {}): Promise<RunSummary> {
  const conn = await ctx.sql.reserve();
  try {
    const [got] = (await conn`select pg_try_advisory_lock(${DECIDER_RUN_LOCK_NAMESPACE}::int, hashtext(${data.runId})) as locked`) as unknown as Array<{ locked: boolean }>;
    if (got?.locked !== true) {
      ctx.logger.info({ run: data.runId }, 'decider run already being worked; this job does nothing');
      return { ...emptySummary(), state: 'running' };
    }
    try {
      return await runLocked(ctx, data, deps);
    } finally {
      try {
        await conn`select pg_advisory_unlock(${DECIDER_RUN_LOCK_NAMESPACE}::int, hashtext(${data.runId}))`;
      } catch (err) {
        // the lock goes with the session if the connection is gone
        ctx.logger.warn({ run: data.runId, err: err instanceof Error ? err.name : typeof err }, 'decider run lock release failed');
      }
    }
  } finally {
    conn.release();
  }
}

async function runLocked(ctx: WorkerContext, data: DeciderRunJobData, deps: RunDeps): Promise<RunSummary> {
  const summary = emptySummary();
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const [first] = await ctx.sql<Array<{ library_id: string }>>`select library_id from decider_runs where id = ${data.runId}`;
  if (!first) return { ...summary, state: 'cancelled' };
  // runs of this library left running by a job that died: paused, resumable
  try {
    const stopped = await pauseStaleRuns(ctx.sql, { libraryId: first.library_id });
    if (stopped.length > 0) ctx.logger.warn({ runs: stopped }, 'decider runs with no job left paused as stopped');
  } catch (err) {
    ctx.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'stale decider run check failed');
  }
  const [run] = await ctx.sql<RunRow[]>`
    select id, library_id, decider_id, population, state, model_requested, decider_version, spec_hash, seed
      from decider_runs where id = ${data.runId}`;
  if (!run) return { ...summary, state: 'cancelled' };
  if (!['queued', 'running', 'paused'].includes(run.state)) return { ...summary, state: run.state === 'done' ? 'done' : 'cancelled' };

  // the job_runs mirror: created at the first report, then kept up to date
  const prog: { id: string | null; done: number; total: number } = { id: null, done: 0, total: 0 };
  const progress = async (state: ProgressState, message?: string) => {
    prog.id = await reportProgress(ctx, prog.id, {
      libraryId: run.library_id, type: 'decider.run', subjectType: 'decider_run', subjectId: run.id, state, done: prog.done, total: prog.total,
      ...(message !== undefined ? { message } : {}), ...(state === 'failed' && message !== undefined ? { error: message } : {}),
    });
  };

  const pause = async (reason: PauseReason, message: string): Promise<RunSummary> => {
    const moved = await ctx.sql`
      update decider_runs set state = 'paused', pause_reason = ${reason}, message = ${message}
       where id = ${run.id} and state in ('queued', 'running', 'paused')`;
    if (moved.count === 0) return { ...summary, state: 'cancelled' };
    if (prog.id) await progress('completed', `paused: ${reason}`);
    ctx.logger.info({ run: run.id, reason }, 'decider run paused');
    return { ...summary, state: 'paused', pauseReason: reason };
  };

  if (run.spec_hash !== jevSpecHash()) return pause('spec_changed', 'question changed');
  // a measurement runs on a copy of the library and answers to its own limits, not the module switch
  const measuring = run.population === 'measure';
  if (!measuring && !(await autotaggerEnabled(ctx.sql))) return pause('module_off', 'autotagger off');
  const apiKey = deps.apiKey ?? (await libraryTypesafeKey(ctx, run.library_id));
  if (!apiKey) return pause('no_key', 'no TypeSafe key');
  const config = await autotaggerConfig(ctx.sql, run.library_id);
  // nothing goes out before the owner has seen what goes out (the api checks it too)
  // (a measurement the owner confirmed from the preview may go on without that record)
  if (!config.payloadSeenAt && !(measuring && deps.payloadApproved === true)) return pause('payload_not_seen', 'payload not seen');
  // the measurement enforces its own spend limit; every other run needs the owner's cap
  if (config.monthlyCap === null && !measuring) return pause('no_cap', 'no monthly cap');
  // a measurement has its own limit instead of the monthly cap, and never runs without one
  if (measuring && (deps.maxSpend === undefined || !Number.isFinite(deps.maxSpend) || deps.maxSpend < 0)) return pause('no_cap', 'no measurement limit');
  const decider = deps.decider ?? jevDecider({ apiKey, baseUrl: typesafeBaseUrl(), maxRetries: RUN_MAX_RETRIES });
  const rules = rulesFromStored(await fetchAutoAcceptRulesRow(ctx.db, run.library_id));
  const started = await ctx.sql`
    update decider_runs set state = 'running', pause_reason = null, message = null, started_at = coalesce(started_at, now())
     where id = ${run.id} and state in ('queued', 'running', 'paused')`;
  if (started.count === 0) return { ...summary, state: 'cancelled' };

  const outOfTime = () => clock() - startedAt >= (deps.timeBudgetMs ?? DECIDER_RUN_TIME_BUDGET_MS);
  try {
    return await decideAll(ctx, run, deps, { decider, config, rules, summary, pause, progress, prog, outOfTime });
  } catch (err) {
    const label = err instanceof JevUnavailable ? 'service unavailable' : failureReason(err);
    ctx.logger.error({ run: run.id, error: err instanceof Error ? err.name : typeof err, label }, 'decider run stopped');
    // until the last retry the run stays running, and the retry resumes it
    if (deps.lastAttempt ?? true) {
      await ctx.sql`update decider_runs set state = 'failed', message = ${label}, finished_at = now()
                     where id = ${run.id} and state = 'running'`;
      try {
        await progress('failed', label);
      } catch (progressErr) {
        ctx.logger.warn({ run: run.id, err: progressErr instanceof Error ? progressErr.name : typeof progressErr }, 'decider run progress not marked failed');
      }
    }
    throw err;
  }
}

interface Loop {
  decider: Decider;
  config: Awaited<ReturnType<typeof autotaggerConfig>>;
  rules: ReturnType<typeof rulesFromStored>;
  summary: RunSummary;
  pause: (reason: PauseReason, message: string) => Promise<RunSummary>;
  progress: (state: ProgressState, message?: string) => Promise<void>;
  prog: { done: number; total: number };
  outOfTime: () => boolean;
}

async function decideAll(ctx: WorkerContext, run: RunRow, deps: RunDeps, l: Loop): Promise<RunSummary> {
  const { decider, config, rules, summary, pause, progress, prog, outOfTime } = l;
  let version = run.decider_version;
  // A new run has no pinned model yet. The model the library's last finished
  // run with the same request pinned lets its stored answers be reused, so a
  // re-run over unchanged evidence pays for nothing.
  const [prev] = version ? [] : await ctx.sql<Array<{ v: string }>>`
    select decider_version as v from decider_runs
     where library_id = ${run.library_id} and decider_id = ${run.decider_id} and model_requested = ${run.model_requested}
       and state = 'done' and decider_version is not null and id <> ${run.id}
     order by finished_at desc nulls last, created_at desc limit 1`;
  const prevVersion = prev?.v ?? null;

  const ids = await populationAlbumIds(ctx.sql, run.library_id, run.population, { seed: run.seed, ...(deps.population ?? {}) });
  const decided = new Set((await ctx.sql<Array<{ id: string }>>`
    select local_album_id as id from decider_decisions where run_id = ${run.id}`).map((r) => r.id));
  const todo = ids.filter((id) => !decided.has(id));
  // decided albums that left the population since are not counted: done never passes total
  const doneBefore = ids.length - todo.length;
  prog.done = doneBefore;
  prog.total = ids.length;
  const measuring = run.population === 'measure';
  // this run's own cost so far, possibly billed calls included, in millionths (a resumed run counts what it spent before)
  let runSpent = measuring
    ? Math.round(Number((await ctx.sql<Array<{ c: string }>>`select coalesce(sum(cost), 0)::text as c from decider_calls where run_id = ${run.id}`)[0]?.c ?? 0) * 1e6)
    : 0;
  const tpb = deps.tokensPerByte ?? (await tokensPerByte(ctx.sql, run.library_id));
  const checkEvery = Math.max(1, deps.checkEvery ?? CHECK_EVERY);
  const count = (o: string) => { summary.decided[o] = (summary.decided[o] ?? 0) + 1; };
  /** The run as it now is when it is no longer running (cancelled, or paused from elsewhere); null while it runs. */
  const stoppedMeanwhile = async (): Promise<RunSummary | null> => {
    const [st] = await ctx.sql<Array<{ state: string; pause_reason: string | null }>>`select state, pause_reason from decider_runs where id = ${run.id}`;
    if (st?.state === 'running') return null;
    if (st?.state === 'paused') {
      await progress('completed', `paused: ${st.pause_reason ?? 'stopped'}`);
      return { ...summary, state: 'paused', pauseReason: st.pause_reason };
    }
    await progress('cancelled');
    return { ...summary, state: 'cancelled' };
  };

  for (let i = 0; i < todo.length; i++) {
    const albumId = todo[i]!;
    prog.done = doneBefore + i;
    // pg-boss gave the job up (expired, or the worker is stopping), or its
    // time is up: the rest of the run is queued and the run stays running
    const aborted = deps.signal?.aborted === true;
    if (aborted || (i > 0 && outOfTime())) {
      const next = await ctx.boss.send('decider.run', { runId: run.id }, { singletonKey: deciderRunSingletonKey(run.library_id) });
      if (!next) return pause('stopped', 'stopped: not queued again');
      ctx.logger.info({ run: run.id, next, aborted }, 'decider run job stopped; the rest is queued');
      await progress('running');
      return { ...summary, state: 'running' };
    }
    if (i > 0 && i % checkEvery === 0) {
      const stopped = await stoppedMeanwhile();
      if (stopped) return stopped;
      if (!measuring && !(await autotaggerEnabled(ctx.sql))) return pause('module_off', 'autotagger off');
      await progress('running');
    }

    // the album's evidence, its identify time and whether any sendable
    // candidate lacks evidence, all from one snapshot
    const ev = await ctx.sql.begin('isolation level repeatable read read only', (tx) => loadEvidence(tx, albumId));
    let hash: string | null = null;
    let bytes: number | null = null;
    const record = async (sql: Sql | TxSql, d: DecisionFields) => {
      await sql`
        insert into decider_decisions (run_id, local_album_id, call_id, evidence_hash, last_identify_at, outcome, group_label, group_release_ids,
                                       release_id, distance, source, probability, margin, band, reason, request_bytes)
        values (${run.id}, ${albumId}, ${d.callId ?? null}, ${hash}, ${ev?.lastIdentifyAt ?? null}::timestamptz, ${d.outcome}, ${d.groupLabel ?? null},
                ${d.groupReleaseIds ?? []}::uuid[], ${d.releaseId ?? null}, ${f4(d.distance)}, ${d.source ?? null}, ${f4(d.probability)},
                ${f4(d.margin)}, ${d.band ?? null}, ${d.reason ?? null}, ${bytes})
        on conflict (run_id, local_album_id) do nothing`;
      count(d.outcome);
    };

    if (!ev) { await record(ctx.sql, { outcome: 'no_candidates', reason: 'no_evidence' }); continue; }
    const model = version ?? run.model_requested;
    // the decider's request, with the options the payload preview uses
    let built: DeciderRequest<LoadedEvidence['candidates'][number]>;
    try {
      hash = hashOf(ev);
      built = decider.build(ev.album, ev.candidates, requestOptions(run.population, { model, maxRequestBytes: config.maxRequestBytes }, ev));
    } catch (err) {
      if (err instanceof NotSendableError) {
        // the set is not whole, or there is nothing to send: no hash to pin
        if (err.reason === 'partial_evidence' || err.reason === 'no_candidates') hash = null;
        if (err.reason === 'too_large') bytes = err.bytes;
        await record(ctx.sql, notSent(err));
        continue;
      }
      // Stored evidence that does not hold together (an index outside its
      // tracklist, a number that is not finite, a field missing): this block
      // only computes, so whatever it throws is about this album's data. The
      // album is listed and the run goes on; only the error's class is logged.
      ctx.logger.warn({ run: run.id, album: albumId, error: err instanceof Error ? err.name : typeof err }, 'decider run: album evidence unusable');
      hash = null;
      await record(ctx.sql, { outcome: 'error', reason: 'invalid_evidence' });
      continue;
    }
    const { groups, sent, labels, candidates: cands, payload } = built;
    bytes = built.bytes;

    // A stored call is keyed on exactly what was sent (the shown candidates),
    // so the same evidence asked as another population is never mixed up.
    const sentIds = new Set(sent.flatMap((g) => g.members.map((m) => m.releaseId)));
    const callHash = evidenceHash(ev.album, cands.filter((c) => sentIds.has(c.releaseId)) as EvidenceCandidate[]);
    const stored = async (v: string) => (await ctx.sql<Array<{ id: string; answers: Record<string, number> | string }>>`
      select id, answers from decider_calls
       where local_album_id = ${albumId} and evidence_hash = ${callHash} and spec_hash = ${run.spec_hash} and decider_version = ${v}
         and not possibly_billed
       order by created_at desc, id limit 1`)[0];
    let call: { id: string; answers: Record<string, number> } | null = null;
    const found = version ? await stored(version) : prevVersion ? await stored(prevVersion) : undefined;
    if (found && !version && prevVersion) {
      version = prevVersion;
      await ctx.sql`update decider_runs set decider_version = ${version} where id = ${run.id} and decider_version is null`;
    }

    let answer: DeciderAnswer | null = null;
    let callPrice: Price | null = null;
    if (found) {
      summary.reused += 1;
      call = { id: found.id, answers: answersOf(found.answers) };
    } else {
      // a measurement's price is its own, whatever currency the library counts in
      const price = measuring ? (deps.price ?? (await priceFor(ctx.sql, decider.id, model))) : await priceFor(ctx.sql, decider.id, model);
      const estTokens = Math.ceil(bytes * tpb);
      // cancelled or paused meanwhile: nothing more is paid for
      const stopped = await stoppedMeanwhile();
      if (stopped) return stopped;
      const estimate = price ? costOf(estTokens, price) : 0;
      if (measuring) {
        // the measurement's own limit, in the price's currency; no monthly cap
        if (!price) return pause('no_price', `no price: ${model}`);
        if (runSpent + Math.round(estimate * 1e6) > Math.round(deps.maxSpend! * 1e6)) {
          return pause('cap_reached', `Measurement spent ${(runSpent / 1e6).toFixed(4)} of ${deps.maxSpend} ${price.currency}.`);
        }
      } else {
        const verdict = await checkBudget(ctx.sql, {
          libraryId: run.library_id, cap: config.monthlyCap, currency: config.currency, price, estimate,
        });
        if (!verdict.ok) {
          if (verdict.reason === 'no_price') return pause('no_price', `no price: ${model}`);
          if (verdict.reason === 'no_cap') return pause('no_cap', 'no monthly cap');
          if (verdict.reason === 'currency_mismatch') return pause('currency_mismatch', `price ${price!.currency}, cap ${config.currency}`);
          return pause('cap_reached', `spent ${verdict.spent.toFixed(4)} of ${verdict.cap} ${config.currency}`);
        }
      }
      try {
        answer = await decider.ask({ album: ev.album, groups: sent, payload }, { model });
      } catch (err) {
        if (err instanceof JevKeyRefused) return pause('key_refused', `key refused${err.status ? ` (HTTP ${err.status})` : ''}`);
        if (err instanceof JevRejected) {
          // the service's text can quote the owner's tags: only the status is kept
          ctx.logger.warn({ run: run.id, album: albumId, status: err.status, error: err.name }, 'decider request rejected');
          await record(ctx.sql, { outcome: 'rejected', reason: `HTTP ${err.status}` });
          continue;
        }
        if (err instanceof JevUnavailable && maybeBilled(err)) {
          // No answer, but each request sent may be on the bill: kept at the
          // estimate times the requests (every attempt the client may make,
          // when it does not say), so the cap overstates, never understates.
          // Never reused as an answer.
          const sentTimes = Math.max(1, err.attempts ?? RUN_MAX_RETRIES + 1);
          const tokens = estTokens * sentTimes;
          await ctx.sql`
            insert into decider_calls (library_id, local_album_id, run_id, evidence_hash, spec_hash, decider_id, decider_version,
                                       request_bytes, input_tokens, cost, currency, answers, possibly_billed)
            values (${run.library_id}, ${albumId}, ${run.id}, ${callHash}, ${run.spec_hash}, ${decider.id}, ${model},
                    ${bytes * sentTimes}, ${tokens}, ${price ? costOf(tokens, price) : 0}, ${price?.currency ?? config.currency}, null, true)`;
        }
        throw err; // pg-boss retries; the run resumes after the albums already decided
      }
      callPrice = measuring ? price : ((await priceFor(ctx.sql, decider.id, answer.model)) ?? price);
    }

    if (!answer) {
      await decide(ctx.sql, call!, groups, labels, cands, rules, record);
      continue;
    }
    const a = answer;
    const p = callPrice ?? { perMillionInput: 0, currency: config.currency };
    const changed = version !== null && a.model !== version;
    await ctx.sql.begin(async (tx) => {
      if (!version) await tx`update decider_runs set decider_version = ${a.model} where id = ${run.id} and decider_version is null`;
      // Every paid answer is a row of this run, so the run's own spend counts
      // it. A second paid answer for the same key in the same run (a crash
      // between the call and this write) adds its cost to the run's row, so
      // spend is never undercounted; the first answer stays.
      const [row] = await tx<Array<{ id: string; answers: Record<string, number> | string }>>`
        insert into decider_calls (library_id, local_album_id, run_id, evidence_hash, spec_hash, decider_id, decider_version,
                                   request_bytes, input_tokens, cost, currency, answers)
        values (${run.library_id}, ${albumId}, ${run.id}, ${callHash}, ${run.spec_hash}, ${decider.id}, ${a.model},
                ${a.requestBytes}, ${a.inputTokens}, ${costOf(a.inputTokens, p)}, ${p.currency}, ${JSON.stringify(a.probabilities)}::text::jsonb)
        on conflict (local_album_id, evidence_hash, spec_hash, decider_version, run_id) where not possibly_billed do update
           set cost = decider_calls.cost + excluded.cost, input_tokens = decider_calls.input_tokens + excluded.input_tokens,
               request_bytes = decider_calls.request_bytes + excluded.request_bytes
        returning id, answers`;
      // one run, one dated model: an answer under another is kept, not decided on
      if (changed) return;
      await decide(tx, { id: row!.id, answers: answersOf(row!.answers) }, groups, labels, cands, rules, record);
    });
    summary.billed += 1;
    if (measuring) runSpent += Math.round(costOf(a.inputTokens, p) * 1e6);
    if (changed) return pause('model_changed', `model changed: ${a.model}`);
    if (!version) version = a.model;
    // the answering model's price is in a currency the cap does not count: stop before spending more of it
    if (!measuring && p.currency !== config.currency) return pause('currency_mismatch', `price ${p.currency}, cap ${config.currency}`);
  }

  const finished = await ctx.sql`update decider_runs set state = 'done', finished_at = now() where id = ${run.id} and state = 'running'`;
  if (finished.count === 0) return { ...summary, state: 'cancelled' };
  prog.done = ids.length;
  await progress('completed', Object.entries(summary.decided).map(([k, v]) => `${k} ${v}`).join(', '));
  return summary;
}

/** The decision recorded for an album that is not sent. */
function notSent(err: NotSendableError): DecisionFields {
  switch (err.reason) {
    case 'capped': return { outcome: 'too_large', reason: 'capped' };
    case 'too_large': return { outcome: 'too_large', reason: `${err.bytes} bytes` };
    default: return { outcome: 'no_candidates', reason: err.reason };
  }
}

const answersOf = (a: Record<string, number> | string): Record<string, number> => (typeof a === 'string' ? JSON.parse(a) : a);

/** The decision from a call's answers, with the edition chosen by the owner's rules from the whole group. */
async function decide(
  sql: Sql | TxSql,
  call: { id: string; answers: Record<string, number> },
  groups: TracklistGroup[],
  labels: string[],
  cands: LoadedEvidence['candidates'],
  rules: ReturnType<typeof rulesFromStored>,
  record: (sql: Sql | TxSql, d: DecisionFields) => Promise<void>,
): Promise<void> {
  const decision = decideFromProbabilities(call.answers, JEV_SPEC, { labels });
  if (decision.kind === 'none') {
    await record(sql, { outcome: 'none', callId: call.id, groupLabel: decision.label, probability: decision.probability, margin: decision.margin, reason: decision.reason });
    return;
  }
  const group = groups.find((g) => g.label === decision.label)!;
  const byRelease = new Map(cands.map((c) => [c.releaseId, c] as const));
  const members = group.members.map((m) => byRelease.get(m.releaseId)!);
  const edition = pickEdition(
    members.map((c) => ({ releaseId: c.releaseId, distance: c.distance, provider: c.provider, status: c.status, source: c.source })),
    { preferSource: rules.preferSource, officialOnly: rules.officialOnly });
  const common = { callId: call.id, groupLabel: decision.label, groupReleaseIds: group.members.map((m) => m.releaseId), probability: decision.probability, margin: decision.margin };
  if (!edition) {
    await record(sql, { ...common, outcome: 'none', reason: rules.officialOnly ? 'no_official_edition' : 'no_edition' });
    return;
  }
  await record(sql, { ...common, outcome: 'pick', band: decision.band, releaseId: edition.releaseId, distance: edition.distance, source: edition.source });
}
