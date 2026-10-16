/**
 * The player's background work for people, in the API process (it holds
 * the player and scrobbling credentials; the workers never get them):
 *
 *   every few seconds (and right after a play event): play events → plays →
 *   listens; heard web plays reported to the server; due scrobbles sent;
 *   other apps' "now playing" forwarded (every 20 s)
 *
 *   every minute: the bundled server's accounts kept in step with tagave's
 *   people; each person's plays from other apps read back; ratings pushed
 *
 * Correctness never depends on there being one runner: plays are unique per
 * person and key, scrobbles per play and service, and every step takes its
 * rows with row locks or per-person advisory locks.
 */
import type postgres from 'postgres';
import type { PlayerBackend } from '@tagave/core/player';
import { backendFor, firstLibrary, libraryById, parseSettings } from './player.js';
import { syncBundledUsers } from './playerPeople.js';
import { deriveListens, forwardServerNowPlaying, pollServerPlays, processPlayEvents, reportWebPlays, type PlaysDeps } from './playerPlays.js';
import { syncRatings } from './playerRatings.js';
import { sendDueScrobbles } from './scrobbling.js';

type Sql = postgres.Sql;
type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

const TICK_MS = 10_000;
const MINUTE_MS = 60_000;
const NOW_PLAYING_MS = 20_000;

export async function backendForLibrary(sql: Sql, libraryId: string | null): Promise<PlayerBackend | null> {
  const lib = libraryId ? await libraryById(sql, libraryId) : await firstLibrary(sql);
  return backendFor(lib?.settings ?? {});
}

/** The distinct servers in use: the bundled one, or each library's own. */
export async function activeBackends(sql: Sql): Promise<PlayerBackend[]> {
  const bundled = backendFor({});
  if (bundled?.managed === 'bundled') return [bundled];
  const rows = await sql<{ settings: unknown }[]>`select settings from libraries where settings ? 'playerUrl'`;
  const out = new Map<string, PlayerBackend>();
  for (const r of rows) {
    const b = backendFor(parseSettings(r.settings));
    if (b) out.set(b.key, b);
  }
  return [...out.values()];
}

export interface SyncOptions {
  sql: Sql;
  log?: Log;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export function playsDeps(o: SyncOptions): PlaysDeps {
  return {
    sql: o.sql,
    backendFor: (libraryId) => backendForLibrary(o.sql, libraryId),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.env ? { env: o.env } : {}),
    ...(o.log ? { log: o.log } : {}),
  };
}

/** The fast part: events, listens from them, reports to the server, due scrobbles. */
export async function runPlayerFastSync(o: SyncOptions): Promise<void> {
  const deps = playsDeps(o);
  for (let i = 0; i < 5; i++) {
    const r = await processPlayEvents(deps);
    for (const userId of r.users) await deriveListens(o.sql, userId);
    if (r.events < 200) break;
  }
  await reportWebPlays(deps);
  await sendDueScrobbles(deps);
}

/** The minute part: accounts, plays from other apps, ratings. */
export async function runPlayerMinuteSync(o: SyncOptions): Promise<void> {
  const deps = playsDeps(o);
  for (const backend of await activeBackends(o.sql)) {
    try {
      if (backend.managed === 'bundled') await syncBundledUsers(o.sql, backend, { ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}), ...(o.log ? { log: o.log } : {}) });
      const polled = await pollServerPlays(deps, backend);
      for (const userId of polled.newPlayUsers) await deriveListens(o.sql, userId);
      await syncRatings(deps, backend);
    } catch (err) {
      o.log?.warn({ server: backend.key, err: (err as Error).message }, 'player sync');
    }
  }
  await sendDueScrobbles(deps);
}

export async function runNowPlayingForward(o: SyncOptions): Promise<void> {
  const deps = playsDeps(o);
  for (const backend of await activeBackends(o.sql)) {
    await forwardServerNowPlaying(deps, backend).catch((err) => o.log?.warn({ err: (err as Error).message }, 'now playing'));
  }
}

let kickTimer: NodeJS.Timeout | null = null;
let kickFn: (() => void) | null = null;

/** After a play event: run the fast part soon (debounced), so now-playing and scrobbles go out within seconds. */
export function kickPlayerSync(): void {
  if (!kickFn || kickTimer) return;
  kickTimer = setTimeout(() => { kickTimer = null; kickFn?.(); }, 1500);
  kickTimer.unref?.();
}

/** Starts the loop; returns a stop function. Nothing runs while no player is set up. */
export function startPlayerPeopleWorker(o: SyncOptions): () => void {
  let running = false;
  let again = false;
  let lastMinute = 0;
  let lastNowPlaying = 0;
  const tick = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const backends = await activeBackends(o.sql);
        if (backends.length === 0) {
          // events still become plays and listens without a server (nothing to report to)
          await runPlayerFastSync(o);
          break;
        }
        await runPlayerFastSync(o);
        const now = Date.now();
        if (now - lastNowPlaying >= NOW_PLAYING_MS) { lastNowPlaying = now; await runNowPlayingForward(o); }
        if (now - lastMinute >= MINUTE_MS) { lastMinute = now; await runPlayerMinuteSync(o); }
      } while (again);
    } catch (err) {
      o.log?.warn({ err: (err as Error).message }, 'player background work');
    } finally {
      running = false;
    }
  };
  kickFn = () => void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  void tick();
  return () => { clearInterval(timer); kickFn = null; if (kickTimer) clearTimeout(kickTimer); kickTimer = null; };
}
