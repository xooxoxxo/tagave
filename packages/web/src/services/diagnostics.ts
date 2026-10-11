/**
 * Opt-in freeze diagnostics, for catching a hang on the owner's own browser.
 *
 * Off unless switched on in the browser console:
 *
 *   localStorage.setItem('tagave:diagnostics', '1'); location.reload()
 *
 * Then every frame that keeps the page busy for 200 ms or more is recorded
 * (Long Animation Frames where the browser has them, long tasks elsewhere):
 * when, on which page, for how long, how much of it was style, layout and
 * text, and which scripts ran. Frames of a second or more are also logged as
 * a console warning. The log survives a reload (localStorage, last 200), and
 * a sample of memory and page size is taken every 30 s.
 *
 *   copy(JSON.stringify(tagaveDiagnostics()))   // in DevTools: copies the report
 *   localStorage.removeItem('tagave:diagnostics') // off again
 *
 * Nothing leaves the browser.
 */

export const DIAGNOSTICS_FLAG = 'tagave:diagnostics';
export const DIAGNOSTICS_LOG = 'tagave:diagnostics:log';
const MAX_FRAMES = 200;
const MAX_SAMPLES = 120;
const SAMPLE_MS = 30_000;
const RECORD_MS = 200;
const WARN_MS = 1000;

export interface FrameRecord {
  /** wall-clock time the frame started */
  at: string;
  page: string;
  ms: number;
  /** ms in which input could not be handled (LoAF blockingDuration) */
  blockingMs?: number;
  /** ms of style, layout and text at the end of the frame (LoAF) */
  styleLayoutMs?: number;
  visible: boolean;
  scripts?: Array<{ invoker: string; source: string; fn: string; ms: number; forcedLayoutMs: number }>;
}

export interface Sample { at: string; page: string; heapMB: number | null; elements: number; visible: boolean }

export interface DiagnosticsReport {
  userAgent: string;
  startedAt: string;
  frames: FrameRecord[];
  samples: Sample[];
}

interface LoafScript {
  invoker?: string; sourceURL?: string; sourceCharPosition?: number; sourceFunctionName?: string;
  duration: number; forcedStyleAndLayoutDuration?: number;
}
interface LoafEntry extends PerformanceEntry {
  blockingDuration?: number; styleAndLayoutStart?: number; scripts?: LoafScript[];
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function diagnosticsEnabled(): boolean {
  try {
    return storage()?.getItem(DIAGNOSTICS_FLAG) === '1';
  } catch {
    return false;
  }
}

/** One long frame as a small, JSON-safe record. */
export function frameRecord(e: LoafEntry, timeOrigin: number, page: string, visible: boolean): FrameRecord {
  const end = e.startTime + e.duration;
  const r: FrameRecord = { at: new Date(timeOrigin + e.startTime).toISOString(), page, ms: Math.round(e.duration), visible };
  if (typeof e.blockingDuration === 'number') r.blockingMs = Math.round(e.blockingDuration);
  if (typeof e.styleAndLayoutStart === 'number' && e.styleAndLayoutStart > 0) r.styleLayoutMs = Math.round(end - e.styleAndLayoutStart);
  if (e.scripts?.length) {
    r.scripts = e.scripts
      .filter((s) => s.duration >= 10)
      .slice(0, 8)
      .map((s) => ({
        invoker: String(s.invoker ?? ''),
        source: `${String(s.sourceURL ?? '').split('/').pop()}:${s.sourceCharPosition ?? -1}`,
        fn: String(s.sourceFunctionName ?? ''),
        ms: Math.round(s.duration),
        forcedLayoutMs: Math.round(s.forcedStyleAndLayoutDuration ?? 0),
      }));
  }
  return r;
}

function readLog(): FrameRecord[] {
  try {
    const raw = storage()?.getItem(DIAGNOSTICS_LOG);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as FrameRecord[]) : [];
  } catch {
    return [];
  }
}

let started = false;

/** Start recording if the owner switched diagnostics on; returns whether it did. */
export function startDiagnostics(): boolean {
  if (started || !diagnosticsEnabled()) return false;
  started = true;
  const frames = readLog();
  const samples: Sample[] = [];
  const startedAt = new Date().toISOString();
  const page = () => (globalThis.location ? globalThis.location.pathname + globalThis.location.search : '');
  const visible = () => globalThis.document?.visibilityState !== 'hidden';
  const timeOrigin = globalThis.performance?.timeOrigin ?? Date.now();

  const record = (e: LoafEntry) => {
    if (e.duration < RECORD_MS) return;
    const r = frameRecord(e, timeOrigin, page(), visible());
    frames.push(r);
    if (frames.length > MAX_FRAMES) frames.splice(0, frames.length - MAX_FRAMES);
    try {
      storage()?.setItem(DIAGNOSTICS_LOG, JSON.stringify(frames));
    } catch {
      /* storage full: keep it in memory */
    }
    if (r.ms >= WARN_MS) {
      const what = r.styleLayoutMs != null ? `, style/layout/text ${r.styleLayoutMs} ms` : '';
      const top = r.scripts?.[0] ? `, longest script ${r.scripts[0].ms} ms (${r.scripts[0].invoker} ${r.scripts[0].source})` : '';
      console.warn(`tagave diagnostics: the page was busy ${r.ms} ms on ${r.page}${what}${top}`);
    }
  };

  const Observer = globalThis.PerformanceObserver;
  const types = Observer?.supportedEntryTypes ?? [];
  const type = types.includes('long-animation-frame') ? 'long-animation-frame' : types.includes('longtask') ? 'longtask' : null;
  if (Observer && type) {
    try {
      new Observer((list) => { for (const e of list.getEntries()) record(e as LoafEntry); }).observe({ type, buffered: true });
    } catch {
      /* not supported here */
    }
  }

  const sample = () => {
    const mem = (globalThis.performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    samples.push({
      at: new Date().toISOString(),
      page: page(),
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
      elements: globalThis.document?.getElementsByTagName('*').length ?? 0,
      visible: visible(),
    });
    if (samples.length > MAX_SAMPLES) samples.shift();
  };
  sample();
  setInterval(sample, SAMPLE_MS);

  (globalThis as unknown as { tagaveDiagnostics: () => DiagnosticsReport }).tagaveDiagnostics = () => ({
    userAgent: globalThis.navigator?.userAgent ?? '',
    startedAt,
    frames: [...frames],
    samples: [...samples],
  });
  console.info(`tagave diagnostics on: frames of ${RECORD_MS} ms or more are recorded. copy(JSON.stringify(tagaveDiagnostics())) copies the report.`);
  return true;
}
