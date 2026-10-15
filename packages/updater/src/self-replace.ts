/**
 * The hand-over after a successful update, when the updater replaces its own
 * container with one on the new updater image (update.ts, replaceSelf). The
 * process doing the hand-over is killed a few seconds later, so a run it
 * accepted in that window would be cut off half done.
 *
 * Before it hands over, the updater records a marker in .updater/state.json
 * ("replacing self, expecting version X") and from then on refuses
 * POST /v1/update with 409. The replacement clears the marker when it starts:
 *
 *   its version is X                  done; logged as info
 *   another version                   cleared with a warning (the hand-over
 *                                     went wrong, or someone restarted the
 *                                     old image); runs are accepted again
 *   marker older than STALE_MS        cleared with a warning, also by a
 *                                     process that is still refusing, so the
 *                                     updater can never refuse forever
 *
 * One exception: a process on the version that handed over (fromVersion)
 * may be the old updater itself, restarted by Docker before it was replaced.
 * It keeps the marker while the hand-over container (labelled HANDOVER_LABEL)
 * still runs, and drops it once that container is gone.
 *
 * The process that hands over drops the marker itself when it is still alive
 * after the hand-over should have killed it: Docker says the one-off was never
 * created, the one-off exits (docker wait), or a backstop timer runs out
 * (update.ts). A `compose run` that times out is no proof either way, so the
 * marker stays until one of those decides.
 */
import type { UpdateRun, UpdaterSelfReplace } from '@tagave/shared/updater';

/** Same as SELF_REPLACE_STALE_MS in @tagave/shared (kept here so the image needs no runtime packages). */
export const SELF_REPLACE_STALE_MS = 10 * 60_000;

export type SelfReplaceMarker = UpdaterSelfReplace;

/** The label on the one-off container that replaces the updater; its value is the run id. */
export const HANDOVER_LABEL = 'tagave.updater.handover';

/** The key of the marker in state.json, next to the run's own fields. */
const KEY = 'selfReplace';

/** What update.ts calls around the hand-over. */
export interface SelfReplaceHooks {
  /** Before the one-off container that replaces this one starts. */
  begin(expectedVersion: string, runId: string): Promise<void>;
  /** That container did not start: this process stays, so runs may start again. */
  abort(reason: string): Promise<void>;
}

export type SelfReplaceLog = (level: 'info' | 'warn', message: string, fields: Record<string, unknown>) => void;

const consoleLog: SelfReplaceLog = (level, message, fields) => {
  const line = JSON.stringify({ msg: message, level, ...fields });
  if (level === 'warn') console.warn(line);
  else console.log(line);
};

/** The 409 message while a hand-over is pending. */
export function refusalMessage(marker: SelfReplaceMarker): string {
  return `the updater is restarting itself on version ${marker.expectedVersion}; try again in a minute`;
}

function ageMs(marker: SelfReplaceMarker, now: Date): number {
  const since = Date.parse(marker.since);
  // An unreadable time, or one in the future, counts as stale: never refuse on a marker we cannot age.
  if (!Number.isFinite(since) || since > now.getTime() + 60_000) return Number.POSITIVE_INFINITY;
  return now.getTime() - since;
}

export function isStale(marker: SelfReplaceMarker, now: Date, staleMs = SELF_REPLACE_STALE_MS): boolean {
  return ageMs(marker, now) > staleMs;
}

function isMarker(v: unknown): v is SelfReplaceMarker {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return typeof m['expectedVersion'] === 'string' && typeof m['since'] === 'string';
}

/** state.json: the last run, plus the marker while a hand-over is pending. Older files hold only the run. */
export function parseState(text: string): { run: UpdateRun | null; marker: SelfReplaceMarker | null } {
  const raw = JSON.parse(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return { run: null, marker: null };
  const { [KEY]: m, ...rest } = raw;
  const marker = isMarker(m)
    ? { expectedVersion: m.expectedVersion, fromVersion: typeof m.fromVersion === 'string' ? m.fromVersion : 'unknown', runId: typeof m.runId === 'string' ? m.runId : '', since: m.since }
    : null;
  return { run: typeof rest['id'] === 'string' ? (rest as unknown as UpdateRun) : null, marker };
}

export function serializeState(run: UpdateRun, marker: SelfReplaceMarker | null): string {
  return `${JSON.stringify(marker ? { ...run, [KEY]: marker } : run, null, 2)}\n`;
}

interface SelfReplaceGateOptions {
  /** This process's own version. */
  version: string;
  /** Whether a hand-over container is running now (null: Docker did not answer). */
  handoverRunning?: () => Promise<boolean | null>;
  /** Writes state.json with the current run and marker. */
  persist: () => Promise<void>;
  now?: () => Date;
  staleMs?: number;
  log?: SelfReplaceLog;
}

/** Holds the marker for one updater process and decides whether a run may start. */
export class SelfReplaceGate implements SelfReplaceHooks {
  private marker: SelfReplaceMarker | null = null;
  /** The marker came from state.json and this may be the old updater restarted: it waits on the hand-over container. */
  private waitingOnHandover = false;
  private readonly now: () => Date;
  private readonly staleMs: number;
  private readonly log: SelfReplaceLog;

  constructor(private readonly opts: SelfReplaceGateOptions) {
    this.now = opts.now ?? (() => new Date());
    this.staleMs = opts.staleMs ?? SELF_REPLACE_STALE_MS;
    this.log = opts.log ?? consoleLog;
  }

  /** The marker, as written into state.json. */
  get current(): SelfReplaceMarker | null {
    return this.marker;
  }

  /**
   * On start, with the marker found in state.json. A process that starts is
   * never the one that handed over; it clears the marker, except when it may
   * be that old updater restarted by Docker before the hand-over finished.
   */
  async adopt(found: SelfReplaceMarker | null): Promise<void> {
    if (!found) return;
    const v = this.opts.version;
    const fields = { expectedVersion: found.expectedVersion, fromVersion: found.fromVersion, since: found.since, version: v };
    if (isStale(found, this.now(), this.staleMs)) {
      this.log('warn', `found a restart onto ${found.expectedVersion} from ${found.since} that never finished; this updater runs ${v}. Cleared it: updates can start again`, fields);
    } else if (found.fromVersion === v) {
      const running = await this.handoverRunning();
      if (running === true || (running === null && found.expectedVersion !== v)) {
        this.log('warn', `restarted on ${v} while the hand-over to ${found.expectedVersion} ${running ? 'still runs' : 'may still run'}; refusing updates until it is done`, fields);
        this.marker = found;
        this.waitingOnHandover = true;
        return;
      }
      if (found.expectedVersion === v) this.log('info', `the updater restarted on ${v} as planned`, fields);
      else this.log('warn', `the hand-over to ${found.expectedVersion} ended without replacing this updater (${v}). Cleared the restart marker: updates can start again`, fields);
    } else if (found.expectedVersion === v) {
      this.log('info', `the updater restarted on ${v} as planned`, fields);
    } else {
      this.log('warn', `the updater was to restart on ${found.expectedVersion} but runs ${v}. Cleared the restart marker: updates can start again`, fields);
    }
    this.marker = null;
    await this.save();
  }

  private async handoverRunning(): Promise<boolean | null> {
    if (!this.opts.handoverRunning) return null;
    try {
      return await this.opts.handoverRunning();
    } catch {
      return null;
    }
  }

  async begin(expectedVersion: string, runId: string): Promise<void> {
    this.marker = { expectedVersion, fromVersion: this.opts.version, runId, since: this.now().toISOString() };
    await this.save();
  }

  async abort(reason: string): Promise<void> {
    if (!this.marker) return;
    this.log('warn', `${reason}; still on ${this.opts.version}`, { expectedVersion: this.marker.expectedVersion });
    this.marker = null;
    this.waitingOnHandover = false;
    await this.save();
  }

  /** The marker, after dropping it when stale. */
  async check(): Promise<SelfReplaceMarker | null> {
    const m = this.marker;
    if (m && isStale(m, this.now(), this.staleMs)) {
      this.log('warn', `the restart onto ${m.expectedVersion} did not happen within ${Math.round(this.staleMs / 60_000)} min; accepting updates again`, { expectedVersion: m.expectedVersion, since: m.since });
      this.marker = null;
      this.waitingOnHandover = false;
      await this.save();
    } else if (m && this.waitingOnHandover && (await this.handoverRunning()) === false) {
      this.log('warn', `the hand-over to ${m.expectedVersion} is gone without replacing this updater; accepting updates again`, { expectedVersion: m.expectedVersion });
      this.marker = null;
      this.waitingOnHandover = false;
      await this.save();
    }
    return this.marker;
  }

  /** The marker as /v1/status shows it, with its age by this process's clock (the page never compares clocks). */
  async status(): Promise<(SelfReplaceMarker & { ageMs: number }) | null> {
    const m = await this.check();
    if (!m) return null;
    const age = ageMs(m, this.now());
    return { ...m, ageMs: Number.isFinite(age) ? Math.max(0, age) : this.staleMs };
  }

  /** Why a run may not start now, or null. */
  async refusal(): Promise<string | null> {
    const m = await this.check();
    return m ? refusalMessage(m) : null;
  }

  private async save(): Promise<void> {
    // The marker in memory is what gates this process; a failed write only
    // loses it for the next one, which clears it on start anyway.
    try {
      await this.opts.persist();
    } catch (err) {
      this.log('warn', `could not write the restart marker to state.json: ${(err as Error).message}`, {});
    }
  }
}
