/**
 * Background activity in plain words (Settings › Background activity).
 *
 * job_runs is a worker-owned mirror: heartbeats every 30 s, hourly sweeps
 * that usually find nothing, rows the API inserts as "created" that the
 * worker never adopts (it writes its own row), and "running" rows left behind
 * when a worker restarts mid-job. Shown raw, that is a wall of
 * "worker.heartbeat / completed". This module turns rows into what the owner
 * can act on: what ran, how it went, what needs them, what they can retry.
 */
import type { JobView, JobViewStatus, JobsSummary } from '@liner/shared';

/** Worker bookkeeping, never shown (the health page reads it). */
export const HIDDEN_JOB_TYPES = ['worker.heartbeat'] as const;

/**
 * Scheduled maintenance that runs on its own every hour or day. A finished
 * run is routine and hidden by default; a failed one is never routine.
 */
export const ROUTINE_JOB_TYPES = [
  'enrich.sweep',
  'collection.sync',
  'gaps.recompute',
  'queue.autoaccept',
  'artists.resolve',
] as const;

/** A running row that has not finished after this long was abandoned. */
export const STALE_AFTER_MS = 12 * 3600_000;
/**
 * Rows that legitimately stay "running" for days: the worker updates them in
 * place and never moves startedAt (identify.sweep tops up forever;
 * artists.resolve reuses its newest row and sets it back to running while
 * release groups are pending). job_runs has no updated_at to judge them by.
 */
const LONG_RUNNING = new Set(['identify.sweep', 'artists.resolve']);

/** A job_runs row as the route loads it, plus the scan root's name when it has one. */
export interface JobRow {
  id: string;
  type: string;
  subjectType: string | null;
  subjectId: string | null;
  state: string;
  progress: unknown;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  error: string | null;
  createdAt: Date | string;
  subjectName?: string | null;
}

/** Raw client queries hand timestamps over as strings; drizzle as Dates. */
export function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function ms(value: Date | string | null | undefined): number | null {
  const iso = toIso(value);
  return iso ? Date.parse(iso) : null;
}

interface Progress { done: number; total: number; message: string | null }

/** job_runs.progress is jsonb: an object from the driver, a string on older rows. */
export function parseProgress(value: unknown): Progress {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    done: num(obj['done']),
    total: num(obj['total']),
    message: typeof obj['message'] === 'string' && obj['message'] ? obj['message'] : null,
  };
}

const n = (v: number) => v.toLocaleString('en-US');
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

/** What the task does, in the owner's words. Unknown types never leak their id. */
export function jobLabel(type: string, subjectName?: string | null): string {
  switch (type) {
    case 'scan.root': return subjectName ? `Scan ${subjectName}` : 'Scan music folder';
    case 'scan.dir': return subjectName ? `Rescan a folder in ${subjectName}` : 'Rescan a folder';
    case 'identify.sweep': return 'Identify albums';
    case 'enrich.sweep': return 'Look up release details';
    case 'collection.sync': return 'Sync Discogs collection';
    case 'gaps.recompute': return 'Check for gaps and duplicates';
    case 'queue.autoaccept': return 'Accept confident matches';
    case 'artists.resolve': return 'Link artists';
    case 'tags.preview': return 'Preview a tag plan';
    default: return 'Background task';
  }
}

/** Scan result, e.g. "quick: 241516 seen, 0 added, 0 changed, 0 missing, 72502/72502 dirs skipped, 285s". */
function scanSummary(message: string): string | null {
  if (message.startsWith('folder is gone')) return 'The folder is gone; its files are marked missing.';
  const m = /(\d+) seen, (\d+) added, (\d+) changed, (\d+) missing/.exec(message);
  if (!m) return null;
  const [seen, added, changed, missing] = m.slice(1, 5).map(Number) as [number, number, number, number];
  const changes = [
    added ? `${n(added)} added` : null,
    changed ? `${n(changed)} changed` : null,
    missing ? `${n(missing)} missing` : null,
  ].filter(Boolean);
  return `Checked ${plural(seen, 'file')}: ${changes.length ? changes.join(', ') : 'no changes'}.`;
}

/** One plain sentence for the row, or null when there is nothing worth saying. */
export function jobSummary(type: string, status: JobViewStatus, p: Progress): string | null {
  const msg = p.message ?? '';
  if (status === 'interrupted') return 'Stopped before it finished, most likely because the app restarted.';
  if (status === 'waiting') return 'Waiting to start.';
  if (status === 'cancelled') return 'Cancelled.';
  if (status === 'failed') return null; // the error says it

  if (type === 'scan.root' || type === 'scan.dir') {
    if (status === 'running') return p.done ? `${plural(p.done, 'file')} checked so far.` : 'Starting.';
    return scanSummary(msg);
  }
  if (type === 'identify.sweep') {
    if (status === 'running') {
      return p.total ? `${n(p.done)} of ${plural(p.total, 'album')} checked.` : 'Checking albums.';
    }
    const m = /(\d+) of (\d+) albums identified/.exec(msg);
    if (m) return `Went through ${plural(Number(m[2]), 'album')}; ${n(Number(m[1]))} identified.`;
    return p.total ? `Went through ${plural(p.total, 'album')}.` : null;
  }
  if (type === 'enrich.sweep') {
    const m = /enqueued (\d+) releases/.exec(msg);
    if (m) return Number(m[1]) ? `Queued ${plural(Number(m[1]), 'release')} for a Discogs lookup.` : 'Nothing new to look up.';
  }
  if (type === 'collection.sync') {
    if (status === 'running') return 'Syncing.';
    const m = /Mapped (\d+)\/(\d+)/.exec(msg);
    if (m) return Number(m[2]) ? `Matched ${n(Number(m[1]))} of ${plural(Number(m[2]), 'new item')} to your library.` : 'No new items in your collection.';
  }
  if (type === 'gaps.recompute') {
    const counts = Object.fromEntries([...msg.matchAll(/(\w+):(\d+)/g)].map((m) => [m[1], Number(m[2])]));
    const parts = [
      counts['incomplete_album'] ? plural(counts['incomplete_album'], 'incomplete album') : null,
      counts['duplicate'] ? plural(counts['duplicate'], 'duplicate') : null,
      counts['missing_album'] ? plural(counts['missing_album'], 'missing album') : null,
    ].filter(Boolean);
    if (Object.keys(counts).length) return parts.length ? `Open: ${parts.join(', ')}.` : 'No gaps found.';
  }
  if (type === 'tags.preview') {
    // the worker writes its own plain progress line ("Comparing tags: 4 of 15 files")
    if (msg) return msg.endsWith('.') ? msg : `${msg}.`;
    return status === 'running' ? 'Comparing tags.' : null;
  }
  if (type === 'queue.autoaccept') {
    const m = /(\d+)\/(\d+)/.exec(msg);
    if (m) return `Accepted ${n(Number(m[1]))} of ${plural(Number(m[2]), 'album')} waiting for review.`;
  }
  if (status === 'running' && p.total) return `${n(p.done)} of ${n(p.total)} done.`;
  return null;
}

/**
 * The scheduled quick scan (every few hours) that found nothing new: routine.
 * A full scan, which is what "Scan now" runs, always stays visible.
 */
export function isQuietQuickScan(type: string, message: string | null): boolean {
  if (type !== 'scan.root' || !message) return false;
  return /^quick: \d+ seen, 0 added, 0 changed, 0 missing\b/.test(message);
}

/**
 * Same work, run again: a later row of the same type and subject. scan.dir
 * rows use the scan root as their subject and job_runs does not keep the
 * folder, so two folder rescans are never the same work: each is its own key.
 */
const workKey = (r: JobRow) => (r.type === 'scan.dir' ? `scan.dir|${r.id}` : `${r.type}|${r.subjectId ?? ''}`);

/** A row the worker actually picked up (not a request still waiting in pg-boss). */
function hasStarted(r: JobRow): boolean {
  return r.startedAt != null || ['running', 'paused', 'completed', 'failed', 'cancelled'].includes(r.state);
}

/** The pg-boss job that starts this work again, or null when it cannot be restarted from here. */
export function retryRequest(
  row: Pick<JobRow, 'type' | 'subjectType' | 'subjectId'>,
  libraryId: string,
): { queue: string; data: Record<string, unknown>; singletonKey: string } | null {
  switch (row.type) {
    case 'scan.root':
      if (row.subjectType !== 'scan_root' || !row.subjectId) return null;
      return { queue: 'scan.root', data: { scanRootId: row.subjectId, mode: 'full' }, singletonKey: `scan:${row.subjectId}` };
    case 'identify.sweep':
      return { queue: 'identify.sweep', data: { libraryId, topUp: true }, singletonKey: `identify.sweep:${libraryId}` };
    case 'collection.sync':
      return { queue: 'collection.sync', data: { libraryId }, singletonKey: `collection-sync:${libraryId}` };
    case 'enrich.sweep':
      return { queue: 'enrich.sweep', data: { libraryId }, singletonKey: `enrich-sweep:${libraryId}` };
    case 'gaps.recompute':
      return { queue: 'gaps.recompute', data: { libraryId }, singletonKey: `gaps:${libraryId}` };
    case 'queue.autoaccept':
      return { queue: 'queue.autoaccept', data: { libraryId }, singletonKey: `autoaccept:${libraryId}` };
    case 'artists.resolve':
      return { queue: 'artists.resolve', data: { libraryId }, singletonKey: `artists-resolve:${libraryId}` };
    default:
      return null; // scan.dir needs the folder path, which job_runs does not keep
  }
}

/**
 * A "created"/"queued" row the API inserted while an older run of the same
 * work was already going: pg-boss merged the request (singletonKey) into that
 * run, so nothing will ever pick this row up. It is noise, not a later run.
 */
function mergedRequests(rows: JobRow[], now: number): Set<number> {
  const merged = new Set<number>();
  const byKey = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = workKey(r);
    const list = byKey.get(k);
    if (list) list.push(i); else byKey.set(k, [i]);
  });
  for (const idx of byKey.values()) {
    for (const i of idx) {
      const req = rows[i]!;
      if (req.state !== 'created' && req.state !== 'queued') continue;
      const askedAt = ms(req.createdAt);
      if (askedAt === null) continue;
      // older rows of the same work (the array is newest first)
      const absorbed = idx.some((j) => {
        if (j <= i) return false;
        const run = rows[j]!;
        if (!hasStarted(run) || run.state === 'created' || run.state === 'queued') return false;
        const began = ms(run.startedAt) ?? ms(run.createdAt);
        if (began === null || began > askedAt) return false;
        const ended = ms(run.finishedAt);
        if (ended !== null) return ended >= askedAt; // it was still going when the request came in
        return (run.state === 'running' || run.state === 'paused') && !isStale(run, now);
      });
      if (absorbed) merged.add(i);
    }
  }
  return merged;
}

function isStale(row: JobRow, now: number): boolean {
  const since = ms(row.startedAt) ?? ms(row.createdAt) ?? now;
  return !LONG_RUNNING.has(row.type) && now - since > STALE_AFTER_MS;
}

/**
 * Rows (newest first) → views. `null` for a row that is only noise: an API
 * "created" row whose work a run picked up (pg-boss merged the request into a
 * later run, or into one already going when it was made).
 */
export function deriveJobViews(rows: JobRow[], libraryId: string, now: number = Date.now()): Array<JobView | null> {
  // Newest → oldest: by the time a row is read, every later row of the same
  // work has been recorded.
  const later = new Map<string, Later>();
  const merged = mergedRequests(rows, now);
  const out: Array<JobView | null> = new Array(rows.length).fill(null);
  const empty: Later = { any: false, nextActive: false, started: false, completedAt: null };

  for (let i = 0; i < rows.length; i++) {
    if (merged.has(i)) continue; // invisible, and says nothing to older rows
    const row = rows[i]!;
    const key = workKey(row);
    let seen = later.get(key) ?? empty;
    if (row.type === 'scan.dir') {
      // Only a later completed scan of the whole root covers a folder rescan.
      const root = later.get(`scan.root|${row.subjectId ?? ''}`);
      seen = root?.completedAt ? { any: true, nextActive: false, started: false, completedAt: root.completedAt } : empty;
    }
    const view = viewOf(row, libraryId, now, seen);
    out[i] = view;
    if (row.type === 'scan.dir') continue; // never the context of another row
    const own = later.get(key) ?? empty;
    // record this row for the older ones that follow in the array
    later.set(key, {
      any: true,
      // a merged request (null view) is invisible: keep what the next row said
      nextActive: view ? view.status === 'running' || view.status === 'waiting' : own.nextActive,
      started: own.started || hasStarted(row),
      completedAt: own.completedAt
        ?? (row.state === 'completed' ? toIso(row.finishedAt) ?? toIso(row.startedAt) ?? toIso(row.createdAt) : null),
    });
  }
  return out;
}

interface Later {
  /** a later row of the same work exists */
  any: boolean;
  /** the next newer attempt is running or waiting to start */
  nextActive: boolean;
  /** a later row of the same work was actually picked up by the worker */
  started: boolean;
  /** when the newest completed one finished */
  completedAt: string | null;
}

function viewOf(row: JobRow, libraryId: string, now: number, later: Later): JobView | null {
  const createdAt = toIso(row.createdAt) ?? new Date(now).toISOString();
  const startedAt = toIso(row.startedAt);
  const finishedAt = toIso(row.finishedAt);
  const p = parseProgress(row.progress);
  const stale = isStale(row, now);

  let status: JobViewStatus;
  let neverStarted = false;
  switch (row.state) {
    case 'created':
    case 'queued':
      if (later.any) return null; // the request was merged into a later run
      status = stale ? 'interrupted' : 'waiting';
      neverStarted = stale;
      break;
    case 'running':
    case 'paused':
      // A later request still waiting to start does not end this run; only a
      // later run the worker actually began does.
      status = later.started || stale ? 'interrupted' : 'running';
      break;
    case 'completed': status = 'done'; break;
    case 'failed': status = 'failed'; break;
    case 'cancelled': status = 'cancelled'; break;
    default: status = 'done';
  }

  const problem = status === 'failed' || status === 'interrupted';
  const resolvedAt = problem ? later.completedAt : null;
  const retrying = problem && !resolvedAt && later.nextActive;
  // Only the newest attempt at a piece of work can need the owner: an older
  // failure is either fixed, being retried, or repeated by a newer failure.
  const needsAttention = problem && !later.any;
  const canRetry = needsAttention && retryRequest(row, libraryId) !== null;
  // Folded away by default: checks that ran as expected, and old failures a
  // later run already dealt with (a retry under way stays visible).
  const routine = (status === 'done'
    && ((ROUTINE_JOB_TYPES as readonly string[]).includes(row.type) || isQuietQuickScan(row.type, p.message)))
    || (problem && later.any && !retrying);

  let summary = jobSummary(row.type, status, p);
  if (neverStarted) summary = 'Never started.';
  if (resolvedAt) summary = 'A later run finished this work.';
  else if (retrying) summary = 'Running again now.';
  else if (problem && later.any) summary = 'Tried again later; see the newer attempt.';

  return {
    id: row.id,
    type: row.type,
    label: jobLabel(row.type, row.subjectName),
    status,
    summary,
    error: row.error && row.error.trim() ? row.error.trim() : null,
    progress: status === 'running' && p.total > 0 ? { done: Math.min(p.done, p.total), total: p.total } : null,
    startedAt,
    finishedAt,
    createdAt,
    at: finishedAt ?? startedAt ?? createdAt,
    routine,
    retryable: canRetry,
    resolvedAt,
    retrying,
    needsAttention,
  };
}

/** Counts for the top of the page, over every derived view (routine included). */
export function summarizeJobs(views: JobView[], routineHidden: number): JobsSummary {
  let running = 0, waiting = 0, needsAttention = 0;
  let lastFinishedAt: string | null = null;
  for (const v of views) {
    if (v.status === 'running') running++;
    else if (v.status === 'waiting') waiting++;
    else if (v.needsAttention) needsAttention++;
    if (v.status === 'done' && (!lastFinishedAt || v.at > lastFinishedAt)) lastFinishedAt = v.at;
  }
  return { running, waiting, needsAttention, routineHidden, lastFinishedAt };
}
