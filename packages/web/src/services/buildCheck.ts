/**
 * Is the server running a newer build than this tab?
 *
 * The bundle knows its own build (vite.config.ts defines __TAGAVE_BUILD__
 * from the image's GIT_SHA and LINER_VERSION build args); the server says
 * which build it runs at /api/v1/version. After an update, a tab that stayed
 * open keeps running the old bundle: its lazy pages may be gone from the
 * server (hashed file names), and new API behaviour may not match.
 *
 * When the check runs (cheap, one small GET, never a polling storm):
 *  - the tab becomes visible or gets focus again (at most every 30 s);
 *  - the job stream opens again after it dropped, as it does when the app
 *    restarts for an update (only the tab that holds the stream sees that);
 *  - otherwise every 5 minutes, and only in a visible tab. The time of the
 *    last check is shared by all tabs in localStorage, and a tab that finds a
 *    new build tells the others over a BroadcastChannel, so one tab asking
 *    is enough.
 *
 * Finding a new build only raises a notice (NewBuildNotice) with a Reload
 * button: the page is never reloaded under someone in the middle of
 * something. The two automatic reloads are elsewhere: right after an in-app
 * update succeeds (InAppUpdate, reloadIntoNewBuild) and when a page's code
 * fails to load because the old files are gone (installChunkErrorReload).
 *
 * A dev bundle (vite dev, a build without GIT_SHA) or a server that does not
 * know its sha never counts as out of date.
 */
import { useSyncExternalStore } from 'react';

export interface BuildId {
  sha: string | null;
  version: string | null;
}

declare const __TAGAVE_BUILD__: BuildId | undefined;

export const DEV_SHA = 'dev';

/** This bundle's build. */
let bundleBuild: BuildId = typeof __TAGAVE_BUILD__ !== 'undefined' ? __TAGAVE_BUILD__ : { sha: DEV_SHA, version: null };


/** Event-driven checks (focus, visibility) run at most this often. */
export const FOCUS_GAP_MS = 30_000;
/** The background check, in a visible tab, across all tabs. */
export const PERIODIC_MS = 5 * 60_000;
/** How often a tab looks whether the background check is due. */
const TICK_MS = 60_000;

const CHECKED_KEY = 'tagave:build-checked-at';
const CHANNEL = 'tagave:build';

/** A sha that identifies a build, lower-cased; null for the dev and unknown markers. */
export function knownSha(sha: string | null | undefined): string | null {
  const s = (sha ?? '').trim().toLowerCase();
  if (!s || s === DEV_SHA || s === 'unknown') return null;
  return s;
}

/**
 * True when the server runs a different build than the bundle. A short sha
 * and the full sha of the same commit match (deploy.sh passes the short one,
 * CI the full one). Unknown on either side is never "different".
 */
export function isNewBuild(bundleSha: string | null | undefined, serverSha: string | null | undefined): boolean {
  const a = knownSha(bundleSha);
  const b = knownSha(serverSha);
  if (!a || !b || a === b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return !(short.length >= 7 && long.startsWith(short));
}

// --- the shared state: the newer build the server runs, if any ---

let newer: BuildId | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function setNewer(build: BuildId): void {
  if (newer && knownSha(newer.sha) === knownSha(build.sha)) return;
  newer = build;
  emit();
}

/** The newer build the server runs, or null. */
export function useNewBuild(): BuildId | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => newer,
    () => newer,
  );
}

export function getNewBuild(): BuildId | null {
  return newer;
}

// --- asking the server ---

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function lastChecked(): number {
  try {
    return Number(storage()?.getItem(CHECKED_KEY)) || 0;
  } catch {
    return 0;
  }
}

function markChecked(at: number): void {
  try {
    storage()?.setItem(CHECKED_KEY, String(at));
  } catch {
    /* blocked storage: this tab just checks on its own schedule */
  }
}

let channel: BroadcastChannel | null = null;
let inFlight: Promise<BuildId | null> | null = null;

async function fetchServerBuild(): Promise<BuildId | null> {
  const res = await fetch('/api/v1/version', { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) return null;
  const body = (await res.json()) as { sha?: string | null; version?: string | null };
  return { sha: body.sha ?? null, version: body.version ?? null };
}

/**
 * Ask the server which build it runs. Returns the newer build, or null when
 * it is the same (or unknown, or the server did not answer). `minGapMs`
 * skips the request when any tab asked that recently.
 */
export async function checkForNewBuild({ minGapMs = 0 }: { minGapMs?: number } = {}): Promise<BuildId | null> {
  if (!knownSha(bundleBuild.sha)) return null;
  if (newer) return newer;
  if (inFlight) return inFlight;
  const now = Date.now();
  if (minGapMs > 0 && now - lastChecked() < minGapMs) return null;
  markChecked(now);
  inFlight = (async () => {
    try {
      const server = await fetchServerBuild();
      if (!server || !isNewBuild(bundleBuild.sha, server.sha)) return null;
      setNewer(server);
      try {
        channel?.postMessage({ kind: 'new-build', sha: server.sha, version: server.version });
      } catch {
        /* ignore */
      }
      return server;
    } catch {
      return null; // offline or restarting: the next trigger asks again
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function visible(): boolean {
  return globalThis.document?.visibilityState !== 'hidden';
}

let stopWatch: (() => void) | null = null;

/**
 * Start watching for a newer build (once per tab). `onReconnect` subscribes
 * to the job stream's reconnects (services/jobStream.ts onJobStreamReconnect).
 */
export function startBuildWatch(onReconnect?: (listener: () => void) => () => void): () => void {
  if (stopWatch) return stopWatch;
  if (!knownSha(bundleBuild.sha)) {
    stopWatch = () => undefined;
    return stopWatch;
  }
  const onVisible = () => { if (visible()) void checkForNewBuild({ minGapMs: FOCUS_GAP_MS }); };
  const tick = () => { if (visible()) void checkForNewBuild({ minGapMs: PERIODIC_MS }); };
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e: MessageEvent<{ kind?: string; sha?: string | null; version?: string | null }>) => {
      const msg = e.data;
      if (msg?.kind === 'new-build' && isNewBuild(bundleBuild.sha, msg.sha)) setNewer({ sha: msg.sha ?? null, version: msg.version ?? null });
    };
  }
  globalThis.document?.addEventListener?.('visibilitychange', onVisible);
  globalThis.addEventListener?.('focus', onVisible);
  globalThis.addEventListener?.('online', onVisible);
  const offReconnect = onReconnect?.(() => { void checkForNewBuild(); });
  const timer = setInterval(tick, TICK_MS);
  stopWatch = () => {
    clearInterval(timer);
    offReconnect?.();
    globalThis.document?.removeEventListener?.('visibilitychange', onVisible);
    globalThis.removeEventListener?.('focus', onVisible);
    globalThis.removeEventListener?.('online', onVisible);
    channel?.close();
    channel = null;
    stopWatch = null;
  };
  return stopWatch;
}

/**
 * Reload into the new build if the server runs one: after an in-app update
 * succeeded (Settings › Updates). Asks up to `tries` times, `gapMs` apart, as
 * the app may still be settling; does nothing for a dev bundle.
 */
export async function reloadIntoNewBuild({ tries = 3, gapMs = 2000, reload = () => globalThis.location.reload() }: { tries?: number; gapMs?: number; reload?: () => void } = {}): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise((ok) => setTimeout(ok, gapMs));
    if (await checkForNewBuild()) {
      reload();
      return true;
    }
  }
  return false;
}

// --- a page's code that is gone ---

const RELOAD_KEY = 'tagave:stale-reload-at';
/** A second chunk failure within this time of the last reload shows the error instead of reloading again. */
export const RELOAD_GUARD_MS = 60_000;

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * One hard reload when a lazy page or its CSS fails to load: after an update
 * the old hashed files are gone, and the fresh index.html points at the new
 * ones. Guarded against loops: no second reload within RELOAD_GUARD_MS (the
 * time is kept in sessionStorage, per tab), none without sessionStorage to
 * keep it in, none while the browser says it is offline. Returns whether it
 * reloaded.
 */
export function reloadForMissingChunk({
  now = Date.now(),
  store = sessionStore(),
  online = globalThis.navigator?.onLine !== false,
  reload = () => globalThis.location.reload(),
}: { now?: number; store?: Storage | null; online?: boolean; reload?: () => void } = {}): boolean {
  if (!store || !online) return false;
  try {
    const last = Number(store.getItem(RELOAD_KEY)) || 0;
    if (now - last < RELOAD_GUARD_MS && now >= last) return false;
    store.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

/**
 * Vite fires `vite:preloadError` when a dynamic import (lazy routes,
 * React.lazy) or the CSS it needs fails to load. It is fired for every lazy
 * chunk the built app loads, so this one listener covers them all.
 */
export function installChunkErrorReload(): () => void {
  const onError = () => { reloadForMissingChunk(); };
  globalThis.addEventListener?.('vite:preloadError', onError);
  return () => globalThis.removeEventListener?.('vite:preloadError', onError);
}

/** Test seam: forget the newer build and the watch; optionally pretend to be another bundle. */
export function resetBuildCheckForTests(bundle?: BuildId): void {
  if (bundle) bundleBuild = bundle;
  stopWatch?.();
  newer = null;
  inFlight = null;
  emit();
}
