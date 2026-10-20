/**
 * Is the app down (restarting for an update)? The page stays loaded while
 * the app restarts, so it can say so and come back on its own.
 *
 * Trouble is reported by the api client (a request the network refused, or a
 * 502/503/504 from in front of the app) and by the job stream dropping. Then
 * this asks /api/v1/version, every PROBE_MS: two misses in a row and the
 * app counts as down (one miss is a blip); the first answer and it is back.
 * Once back after being down, a newer build the server runs is noted
 * (`switchPending`): the down screen's host reloads into it at the next
 * moment nothing plays, never in the middle of a track.
 */
import { useSyncExternalStore } from 'react';
import { checkForNewBuild } from './buildCheck';

export const PROBE_MS = 2000;
/** After this many misses the probe slows down: a long outage is not an update's restart. */
const SLOW_AFTER = 60;
const SLOW_PROBE_MS = 5000;
/** Misses in a row before the app counts as down. */
export const DOWN_AFTER = 2;

export interface AppDownState {
  down: boolean;
  /** when this tab saw the app go down (ms) */
  since: number | null;
  /** back after being down, and the server runs a newer build than this tab */
  switchPending: boolean;
}

let state: AppDownState = { down: false, since: null, switchPending: false };
const listeners = new Set<() => void>();
const set = (next: Partial<AppDownState>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

export function useAppDown(): AppDownState {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => state,
    () => state,
  );
}

export function getAppDown(): AppDownState {
  return state;
}

/** Whether the app answers: any HTTP answer from it counts (a 401 is the app answering too). */
export async function appAnswers(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetcher('/api/v1/version', { cache: 'no-store', credentials: 'same-origin' });
    return res.status < 502 || res.status > 504;
  } catch {
    return false;
  }
}

/** An api answer that means the app itself is not there. */
export const isGoneStatus = (status: number) => status === 502 || status === 503 || status === 504;

let probing: Promise<void> | null = null;

interface ProbeDeps {
  answers?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  newBuild?: () => Promise<unknown>;
  now?: () => number;
}

/** Something failed the way a restart fails: ask whether the app answers, until it does. */
export function noticeTrouble(deps: ProbeDeps = {}): Promise<void> {
  if (probing) return probing;
  const answers = deps.answers ?? (() => appAnswers());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const newBuild = deps.newBuild ?? (() => checkForNewBuild());
  const now = deps.now ?? Date.now;
  probing = (async () => {
    let misses = 0;
    try {
      for (;;) {
        if (await answers()) break;
        misses++;
        if (misses >= DOWN_AFTER && !state.down) set({ down: true, since: now() });
        await sleep(misses > SLOW_AFTER ? SLOW_PROBE_MS : PROBE_MS);
      }
      if (state.down) {
        set({ down: false, since: null });
        // the server may still be settling: ask a few times
        for (let i = 0; i < 3 && !state.switchPending; i++) {
          if (await newBuild()) set({ switchPending: true });
          else await sleep(PROBE_MS);
        }
      }
    } finally {
      probing = null;
    }
  })();
  return probing;
}

/** Test seam. */
export function resetAppDownForTests(): void {
  state = { down: false, since: null, switchPending: false };
  probing = null;
  listeners.forEach((l) => l());
}
