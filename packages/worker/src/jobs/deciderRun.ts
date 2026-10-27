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
 * the module is off, there is no key, cap or price, the price is in another
 * currency than the cap, the cap is reached or the key is refused. A pause
 * or a crash resumes where it stopped: albums already decided in the run are
 * skipped, and a stored answer is never paid for twice.
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
  JEV_SPEC, NotSendableError, buildJevRequest, decideFromProbabilities, evidenceHash, groupTracklists, jevSpecHash, pickEdition,
  requestBytes, rulesFromStored,
  type Decider, type DeciderAnswer, type EvidenceCandidate, type GroupingCandidate, type JevRequest, type TracklistGroup,
} from '@tagave/core';
import {
  autotaggerConfig, autotaggerEnabled, checkBudget, costOf, fetchAutoAcceptRulesRow, priceFor, tokensPerByte, type Price,
} from '@tagave/db';
import type { Population } from '@tagave/shared';
import type { WorkerContext } from '../lib/context.js';
import { failureReason } from '../lib/batchFailure.js';
import { loadEvidence, type LoadedEvidence } from '../lib/evidenceStore.js';
import { populationAlbumIds, WEAK_TOP_CANDIDATES } from '../lib/deciderPopulation.js';
import { libraryTypesafeKey } from '../lib/providers.js';
import { jevDecider } from '../lib/jevDecider.js';
import { JevKeyRefused, JevRejected, JevUnavailable, typesafeBaseUrl } from '../lib/jevClient.js';
import { reportProgress } from './progress.js';

/**
 * At most this many tracklist groups go into one request: the best eight by
 * distance (labels A to H). Each group adds its whole tracklist to the
 * shared state, so the request grows with groups × tracks; groups past the
 * eighth are the scorer's far-off candidates, and leaving one out can only
 * turn a pick into "none" (the decider answers each group on its own).
 */
export const MAX_GROUPS = 8;
/**
 * At most this many editions of one group are shown. Editions of a group
 * share its tracklist, so they only add label, country and catalogue lines;
 * the edition accepted is still chosen by the owner's rules from every
 * member of the group, shown or not.
 */
export const MAX_EDITIONS_PER_GROUP = 5;
/**
 * Client retries per call for a run. Every retry after a 5xx or a timeout
 * may be billed without an answer to show for it, so a run allows one.
 */
export const RUN_MAX_RETRIES = 1;
/** How often (in albums) a run looks for a cancel or the module turned off, and reports progress. */
export const CHECK_EVERY = 25;

export interface DeciderRunJobData { runId: string }
export interface RunDeps {
  decider?: Decider;
  apiKey?: string;
  checkEvery?: number;
  /** overrides tokensPerByte() for the cost estimate before each call */
  tokensPerByte?: number;
  /** the measure population's mix (sample and largest albums) */
  population?: { sample: number; largest: number };
  /** no retry follows if this run fails (default true: a direct call has none) */
  lastAttempt?: boolean;
}
export interface RunSummary { state: 'done' | 'paused' | 'cancelled'; pauseReason: string | null; decided: Record<string, number>; reused: number; billed: number }

type PauseReason =
  | 'spec_changed' | 'module_off' | 'no_key' | 'no_cap' | 'no_price' | 'currency_mismatch' | 'cap_reached' | 'key_refused' | 'model_changed';

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

const f4 = (x: number | null | undefined): string | null => (x === null || x === undefined ? null : x.toFixed(4));

/** One album's sendable candidates, once per release (the best distance), in distance order. */
function uniqueByRelease(cands: LoadedEvidence['candidates']): LoadedEvidence['candidates'] {
  const seen = new Set<string>();
  return cands.filter((c) => (seen.has(c.releaseId) ? false : (seen.add(c.releaseId), true)));
}

/** What is shown to the decider: the first groups, the first editions of each. */
function sentGroups(groups: TracklistGroup[]): TracklistGroup[] {
  return groups.slice(0, MAX_GROUPS).map((g) => ({ ...g, members: g.members.slice(0, MAX_EDITIONS_PER_GROUP) }));
}

export async function deciderRunJob(ctx: WorkerContext, data: DeciderRunJobData, deps: RunDeps = {}): Promise<RunSummary> {
  const summary: RunSummary = { state: 'done', pauseReason: null, decided: {}, reused: 0, billed: 0 };
  const [run] = await ctx.sql<RunRow[]>`
    select id, library_id, decider_id, population, state, model_requested, decider_version, spec_hash, seed
      from decider_runs where id = ${data.runId}`;
  if (!run) return { ...summary, state: 'cancelled' };
  if (!['queued', 'running', 'paused'].includes(run.state)) return { ...summary, state: run.state === 'done' ? 'done' : 'cancelled' };

  let progressId: string | null = null;
  const progress = (state: 'running' | 'completed' | 'cancelled', done: number, total: number, message?: string) =>
    reportProgress(ctx, progressId, {
      libraryId: run.library_id, type: 'decider.run', subjectType: 'decider_run', subjectId: run.id, state, done, total,
      ...(message !== undefined ? { message } : {}),
    }).then((id) => { progressId = id; });

  const pause = async (reason: PauseReason, message: string): Promise<RunSummary> => {
    const moved = await ctx.sql`
      update decider_runs set state = 'paused', pause_reason = ${reason}, message = ${message}
       where id = ${run.id} and state in ('queued', 'running', 'paused')`;
    if (moved.count === 0) return { ...summary, state: 'cancelled' };
    if (progressId) await progress('completed', 0, 0, `paused: ${reason}`);
    ctx.logger.info({ run: run.id, reason }, 'decider run paused');
    return { ...summary, state: 'paused', pauseReason: reason };
  };

  if (run.spec_hash !== jevSpecHash()) return pause('spec_changed', 'question changed');
  if (!(await autotaggerEnabled(ctx.sql))) return pause('module_off', 'autotagger off');
  const apiKey = deps.apiKey ?? (await libraryTypesafeKey(ctx, run.library_id));
  if (!apiKey) return pause('no_key', 'no TypeSafe key');
  const config = await autotaggerConfig(ctx.sql, run.library_id);
  // the measurement enforces its own spend limit; every other run needs the owner's cap
  if (config.monthlyCap === null && run.population !== 'measure') return pause('no_cap', 'no monthly cap');
  const decider = deps.decider ?? jevDecider({ apiKey, baseUrl: typesafeBaseUrl(), maxRetries: RUN_MAX_RETRIES });
  const rules = rulesFromStored(await fetchAutoAcceptRulesRow(ctx.db, run.library_id));
  const started = await ctx.sql`
    update decider_runs set state = 'running', pause_reason = null, message = null, started_at = coalesce(started_at, now())
     where id = ${run.id} and state in ('queued', 'running', 'paused')`;
  if (started.count === 0) return { ...summary, state: 'cancelled' };

  try {
    return await decideAll(ctx, run, deps, { decider, config, rules, summary, pause, progress });
  } catch (err) {
    const label = err instanceof JevUnavailable ? 'service unavailable' : failureReason(err);
    ctx.logger.error({ run: run.id, error: err instanceof Error ? err.name : typeof err, label }, 'decider run stopped');
    // until the last retry the run stays running, and the retry resumes it
    if (deps.lastAttempt ?? true) {
      await ctx.sql`update decider_runs set state = 'failed', message = ${label}, finished_at = now()
                     where id = ${run.id} and state = 'running'`;
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
  progress: (state: 'running' | 'completed' | 'cancelled', done: number, total: number, message?: string) => Promise<void>;
}

async function decideAll(ctx: WorkerContext, run: RunRow, deps: RunDeps, l: Loop): Promise<RunSummary> {
  const { decider, config, rules, summary, pause, progress } = l;
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
  const tpb = deps.tokensPerByte ?? (await tokensPerByte(ctx.sql, run.library_id));
  const checkEvery = Math.max(1, deps.checkEvery ?? CHECK_EVERY);
  const count = (o: string) => { summary.decided[o] = (summary.decided[o] ?? 0) + 1; };

  for (let i = 0; i < todo.length; i++) {
    const albumId = todo[i]!;
    if (i > 0 && i % checkEvery === 0) {
      const [st] = await ctx.sql<Array<{ state: string }>>`select state from decider_runs where id = ${run.id}`;
      if (st?.state !== 'running') {
        await progress('cancelled', decided.size + i, ids.length);
        return { ...summary, state: 'cancelled' };
      }
      if (!(await autotaggerEnabled(ctx.sql))) return pause('module_off', 'autotagger off');
      await progress('running', decided.size + i, ids.length);
    }

    // the album's evidence, its identify time and whether any sendable
    // candidate lacks evidence, all from one snapshot
    const { ev, partial } = await ctx.sql.begin('isolation level repeatable read read only', async (tx) => {
      const loaded = await loadEvidence(tx, albumId);
      const [p] = await tx<Array<{ partial: boolean }>>`
        select exists (select 1 from match_candidates where local_album_id = ${albumId}
                          and excluded is not true and source not like 'mc:%' and evidence is null) as partial`;
      return { ev: loaded, partial: p?.partial === true };
    });
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
    if (partial) { await record(ctx.sql, { outcome: 'no_candidates', reason: 'partial_evidence' }); continue; }
    let cands = uniqueByRelease(ev.candidates);
    if (run.population === 'weak') cands = cands.slice(0, WEAK_TOP_CANDIDATES);
    if (cands.length === 0) { await record(ctx.sql, { outcome: 'no_candidates', reason: 'no_candidates' }); continue; }
    const model = version ?? run.model_requested;
    let groups: TracklistGroup[];
    let sent: TracklistGroup[];
    let req: JevRequest;
    try {
      hash = evidenceHash(ev.album, ev.candidates);
      groups = groupTracklists(
        cands.map((c): GroupingCandidate => ({ releaseId: c.releaseId, distance: c.distance, evidence: c.evidence! })),
        { discsKnown: ev.album.discsKnown }, JEV_SPEC.grouping);
      sent = sentGroups(groups);
      req = buildJevRequest(ev.album, sent, model);
    } catch (err) {
      if (err instanceof NotSendableError) {
        await record(ctx.sql, err.reason === 'capped' ? { outcome: 'too_large', reason: 'capped' } : { outcome: 'no_candidates', reason: 'album_title' });
        continue;
      }
      // stored evidence that does not hold together (an index outside its
      // tracklist, a number that is not finite): this album is listed, the
      // run goes on; the message is ours and names no tag
      if (err instanceof RangeError) {
        ctx.logger.warn({ run: run.id, album: albumId, err: err.message }, 'decider run: album evidence unusable');
        await record(ctx.sql, { outcome: 'error', reason: 'invalid_evidence' });
        continue;
      }
      throw err;
    }
    const labels = sent.map((g) => g.label);
    bytes = requestBytes(req);
    if (config.maxRequestBytes !== null && bytes > config.maxRequestBytes) {
      await record(ctx.sql, { outcome: 'too_large', reason: `${bytes} bytes` });
      continue;
    }

    // A stored call is keyed on exactly what was sent (the shown candidates),
    // so the same evidence asked as another population is never mixed up.
    const sentIds = new Set(sent.flatMap((g) => g.members.map((m) => m.releaseId)));
    const callHash = evidenceHash(ev.album, cands.filter((c) => sentIds.has(c.releaseId)) as EvidenceCandidate[]);
    const stored = async (v: string) => (await ctx.sql<Array<{ id: string; answers: Record<string, number> | string }>>`
      select id, answers from decider_calls
       where local_album_id = ${albumId} and evidence_hash = ${callHash} and spec_hash = ${run.spec_hash} and decider_version = ${v}`)[0];
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
      const price = await priceFor(ctx.sql, decider.id, model);
      const verdict = await checkBudget(ctx.sql, {
        libraryId: run.library_id, cap: config.monthlyCap, currency: config.currency, price,
        estimate: price ? costOf(Math.ceil(bytes * tpb), price) : 0,
      });
      if (!verdict.ok && run.population !== 'measure') {
        if (verdict.reason === 'no_price') return pause('no_price', `no price: ${model}`);
        if (verdict.reason === 'no_cap') return pause('no_cap', 'no monthly cap');
        if (verdict.reason === 'currency_mismatch') return pause('currency_mismatch', `price ${price!.currency}, cap ${config.currency}`);
        return pause('cap_reached', `spent ${verdict.spent.toFixed(4)} of ${verdict.cap} ${config.currency}`);
      }
      try {
        answer = await decider.ask({ album: ev.album, groups: sent }, { model });
      } catch (err) {
        if (err instanceof JevKeyRefused) return pause('key_refused', `key refused${err.status ? ` (HTTP ${err.status})` : ''}`);
        if (err instanceof JevRejected) {
          // the service's text can quote the owner's tags: only the status is kept
          ctx.logger.warn({ run: run.id, album: albumId, status: err.status, error: err.name }, 'decider request rejected');
          await record(ctx.sql, { outcome: 'rejected', reason: `HTTP ${err.status}` });
          continue;
        }
        throw err; // pg-boss retries; the run resumes after the albums already decided
      }
      callPrice = (await priceFor(ctx.sql, decider.id, answer.model)) ?? price;
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
      // A second paid answer for the same key (a crash between the call and
      // this write, or a model another run pinned) adds its cost, so spend is
      // never undercounted; the first answer stays.
      const [row] = await tx<Array<{ id: string; answers: Record<string, number> | string }>>`
        insert into decider_calls (library_id, local_album_id, run_id, evidence_hash, spec_hash, decider_id, decider_version,
                                   request_bytes, input_tokens, cost, currency, answers)
        values (${run.library_id}, ${albumId}, ${run.id}, ${callHash}, ${run.spec_hash}, ${decider.id}, ${a.model},
                ${a.requestBytes}, ${a.inputTokens}, ${costOf(a.inputTokens, p)}, ${p.currency}, ${JSON.stringify(a.probabilities)}::text::jsonb)
        on conflict (local_album_id, evidence_hash, spec_hash, decider_version) do update
           set cost = decider_calls.cost + excluded.cost, input_tokens = decider_calls.input_tokens + excluded.input_tokens,
               request_bytes = decider_calls.request_bytes + excluded.request_bytes
        returning id, answers`;
      // one run, one dated model: an answer under another is kept, not decided on
      if (changed) return;
      await decide(tx, { id: row!.id, answers: answersOf(row!.answers) }, groups, labels, cands, rules, record);
    });
    summary.billed += 1;
    if (changed) return pause('model_changed', `model changed: ${a.model}`);
    if (!version) version = a.model;
  }

  const finished = await ctx.sql`update decider_runs set state = 'done', finished_at = now() where id = ${run.id} and state = 'running'`;
  if (finished.count === 0) return { ...summary, state: 'cancelled' };
  await progress('completed', ids.length, ids.length, Object.entries(summary.decided).map(([k, v]) => `${k} ${v}`).join(', '));
  return summary;
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
