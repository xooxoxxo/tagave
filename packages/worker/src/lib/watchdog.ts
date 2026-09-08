/**
 * Event-loop watchdog + per-job timeout (XO-318 follow-ups).
 *
 * The heartbeat the API's /health reads lives on the worker's main event
 * loop on purpose: when scoring blocks the loop, the heartbeat stops and
 * /health says so. What was missing is *why*. A worker thread now pings the
 * main thread and, when pings stop arriving for `stallMs`, writes one log
 * line naming the jobs that were in flight — the main loop cannot report on
 * itself while it is blocked, the thread can.
 *
 * `withTimeout` bounds a single job so one hang (a provider call that never
 * answers) fails that job alone instead of the whole pg-boss batch.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Logger } from 'pino';

export interface InFlightJob {
  queue: string;
  jobId: string;
  label: string;
  startedAt: number;
}

const inFlight = new Map<string, InFlightJob>();

/** Register a job for the watchdog report and run it; the registry is cleared however it ends. */
export async function tracked<T>(queue: string, jobId: string, label: string, fn: () => Promise<T>): Promise<T> {
  inFlight.set(jobId, { queue, jobId, label, startedAt: Date.now() });
  try {
    return await fn();
  } finally {
    inFlight.delete(jobId);
  }
}

export function inFlightSnapshot(): Array<InFlightJob & { runningMs: number }> {
  const now = Date.now();
  return [...inFlight.values()].map((j) => ({ ...j, runningMs: now - j.startedAt }));
}

export class JobTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${Math.round(ms / 1000)} s`);
    this.name = 'JobTimeoutError';
  }
}

/**
 * Reject when `fn` has not settled within `ms`. This cannot interrupt CPU-bound
 * work (a blocked loop cannot fire the timer either) — it bounds async waits.
 */
export function withTimeout<T>(ms: number, what: string, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobTimeoutError(what, ms)), ms);
  });
  return Promise.race([fn(), timeout]).finally(() => clearTimeout(timer));
}

export interface WatchdogHandle {
  /** Largest event-loop delay seen since the last call, in ms; resets the window. */
  maxLagMs(): number;
  stop(): Promise<void>;
}

/**
 * Start the stall detector. `pingMs` is how often the main loop reports in,
 * `stallMs` how long silence must last before the thread logs it.
 */
export function startWatchdog(logger: Logger, opts: { pingMs?: number; stallMs?: number } = {}): WatchdogHandle {
  const pingMs = opts.pingMs ?? 5_000;
  const stallMs = opts.stallMs ?? 30_000;

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const thread = new Worker(new URL(import.meta.url), { workerData: { role: 'watchdog', pingMs, stallMs } });
  thread.on('error', (err) => logger.warn({ err: err.message }, 'watchdog thread error'));
  thread.unref();

  const ping = () => thread.postMessage({ at: Date.now(), inFlight: inFlightSnapshot() });
  ping();
  const timer = setInterval(ping, pingMs);
  timer.unref();

  thread.on('message', (m: { stalledMs: number; inFlight: InFlightJob[] }) => {
    logger.warn({ stalledMs: m.stalledMs, inFlight: m.inFlight.map((j) => `${j.queue}:${j.label}`) }, 'event loop recovered after a stall');
  });

  return {
    maxLagMs() {
      const max = Math.round(histogram.max / 1e6);
      histogram.reset();
      return max;
    },
    async stop() {
      clearInterval(timer);
      histogram.disable();
      await thread.terminate();
    },
  };
}

/* ---- thread side: runs when this module is loaded as the Worker entry ---- */
if (!isMainThread && parentPort && (workerData as { role?: string } | null)?.role === 'watchdog') {
  const { pingMs, stallMs } = workerData as { pingMs: number; stallMs: number };
  let lastPing = Date.now();
  let lastInFlight: InFlightJob[] = [];
  let stalledSince: number | null = null;

  parentPort.on('message', (m: { at: number; inFlight: InFlightJob[] }) => {
    if (stalledSince !== null) {
      parentPort!.postMessage({ stalledMs: Date.now() - stalledSince, inFlight: lastInFlight });
      stalledSince = null;
    }
    lastPing = m.at;
    lastInFlight = m.inFlight;
  });

  setInterval(() => {
    const silentMs = Date.now() - lastPing;
    if (silentMs < stallMs) return;
    if (stalledSince === null) stalledSince = lastPing;
    // The main loop cannot log right now — that is the point of this thread.
    const line = {
      level: 50,
      time: Date.now(),
      msg: 'event loop stalled',
      silentMs,
      inFlight: lastInFlight.map((j) => ({ queue: j.queue, jobId: j.jobId, label: j.label, runningMs: Date.now() - j.startedAt })),
    };
    process.stderr.write(JSON.stringify(line) + '\n');
  }, Math.max(1_000, Math.min(pingMs, stallMs / 2))).unref();
}
