/**
 * The opt-in in-app updater (Settings › Updates). The updater is its own
 * container (`packages/updater`, compose profile "updater"); it holds the
 * state of a run so the page can keep polling while the app restarts. These
 * are the shapes the updater, the api and the web app share. Types only:
 * nothing here runs.
 */
import { z } from 'zod';

/** The steps of one update, in order. `rollback` only runs after a failure. */
export const UPDATE_STEPS = ['preflight', 'backup', 'config', 'pull', 'restart', 'verify', 'rollback'] as const;
export type UpdateStepId = (typeof UPDATE_STEPS)[number];

export type UpdateStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface UpdateStep {
  id: UpdateStepId;
  label: string;
  status: UpdateStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface UpdateLogLine {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/**
 * running      the update is under way
 * succeeded    every component runs the target and reports healthy
 * failed       stopped before anything changed (preflight or backup)
 * rolled_back  the old version runs again (with the database restored when the new one had changed it)
 * rollback_failed  the roll back did not finish; the run says what to do by hand
 * interrupted  the updater itself stopped mid-run (host restart); check the install
 * held         the new version runs; the parts in held wait for the music share
 */
export type UpdateRunStatus = 'running' | 'succeeded' | 'failed' | 'rolled_back' | 'rollback_failed' | 'interrupted' | 'held';

/**
 * The parts of a held run that wait for the music share, by compose service
 * name ("worker-files"), and the share's address from the mount table
 * (null when it is not a network share or the table does not say).
 */
export interface UpdateHeld {
  cause: 'music_unreachable';
  parts: string[];
  server: string | null;
}

/** The parts of an install as the web shows them, by compose service name. The updater is never shown as a part. */
export const PART_LABELS: Readonly<Record<string, string>> = {
  app: 'Web app',
  postgres: 'Database',
  'worker-identify': 'Identify worker',
  'worker-files': 'File worker',
  player: 'Player',
};

export interface UpdateRollback {
  /** The TAGAVE_VERSION put back in .env. */
  version: string;
  /** The new version had applied database migrations, so the backup was restored. */
  restoredDatabase: boolean;
  /** The old version answered healthy afterwards. */
  healthy: boolean;
}

/**
 * Where the running step is, in a few words: "downloading image 2 of 4
 * (340 MB of 1.1 GB)", "waiting for the app: database recovering",
 * "workers: 1 of 2 on 0.9.1". `at` moves only when the message (or the
 * byte count in it) changes, so it says when the step last moved.
 */
export interface UpdateProgress {
  step: string;
  message: string;
  at: string;
}

/**
 * Why a step stalled, once it made no progress for the stall time (2 min by
 * default; TAGAVE_UPDATER_STALL_SECONDS):
 *
 * disk_full          a container or the download hit "no space left on device"
 * oom                a container was killed for want of memory
 * port_conflict      a port the container wants is taken
 * crash_loop         a container keeps exiting and restarting
 * migration_refused  the new app refuses to update the database (its "Not migrating:" line)
 * unhealthy          a container's health check fails
 * db_recovering      Postgres is replaying its log after an unclean stop (wait)
 * download           the image download does not move
 * slow               nothing looks wrong; the step is just slow
 * stuck_stop         a part does not stop when asked
 * stuck_start        a part does not start when asked
 * music_unreachable  the music share is mounted but its server does not answer
 * music_unmounted    the music share is not mounted, and the app says so too
 * docker_unresponsive  Docker itself does not answer
 */
export type UpdateStallCause =
  | 'disk_full'
  | 'oom'
  | 'port_conflict'
  | 'crash_loop'
  | 'migration_refused'
  | 'unhealthy'
  | 'db_recovering'
  | 'download'
  | 'slow'
  | 'stuck_stop'
  | 'stuck_start'
  | 'music_unreachable'
  | 'music_unmounted'
  | 'docker_unresponsive';

export interface UpdateStall {
  cause: UpdateStallCause;
  /** What is wrong, in a sentence. */
  message: string;
  /** What to do about it. */
  advice: string;
  /** The container it is about, if one. */
  service: string | null;
  /** The music share's address from the mount table, when the stall is about the share. */
  server?: string | null;
  /** When the step last moved. */
  since: string;
}

export interface UpdateRun {
  id: string;
  from: string;
  target: string;
  status: UpdateRunStatus;
  startedAt: string;
  finishedAt: string | null;
  steps: UpdateStep[];
  log: UpdateLogLine[];
  /** Why the run failed or rolled back, in one sentence. */
  reason: string | null;
  /**
   * The dump a roll back restores: the one the new app took right before it
   * migrated (known once it answered), or the updater's own when the app
   * takes none. null: no database change needed one.
   */
  backup: string | null;
  rollback: UpdateRollback | null;
  /** The running step's sub-state (absent from updaters before 0.9.1; null once the run ends). */
  progress?: UpdateProgress | null;
  /** Set while the running step makes no progress, with the likely cause; cleared when it moves again. */
  stall?: UpdateStall | null;
  /** Set when the status is held: which parts wait for the music share. */
  held?: UpdateHeld | null;
}

/** The steps of one repair, in order. */
export const REPAIR_STEPS = ['check', 'stop', 'music', 'start', 'verify'] as const;
export type RepairStepId = (typeof REPAIR_STEPS)[number];

/**
 * running    the repair is under way
 * repaired   every part runs again
 * waiting    the parts wait for the music share; the updater checks it again
 * needs_you  something only the owner can fix (disk full, a share not in fstab)
 * failed     the repair could not finish
 */
export type RepairStatus = 'running' | 'repaired' | 'waiting' | 'needs_you' | 'failed';

/** What the check step found wrong (the cause table in the spec). */
export type RepairCause =
  | 'music_unreachable'
  | 'music_unmounted'
  | 'not_in_fstab'
  | 'stuck_stop'
  | 'crash_loop'
  | 'disk_full'
  | 'oom'
  | 'port_conflict'
  | 'app_unhealthy'
  | 'db_recovering'
  | 'docker_unresponsive'
  | 'migration_refused'
  | 'missing';

export interface RepairOutcome {
  cause: RepairCause | null;
  /** The part it is about, by compose service name, if one. */
  service: string | null;
  /** The music share's address from the mount table, when the cause is about the share. */
  server: string | null;
  partsRunning: number;
  partsTotal: number;
}

export interface RepairRun {
  kind: 'repair';
  id: string;
  trigger: 'owner' | 'update' | 'installer';
  status: RepairStatus;
  startedAt: string;
  finishedAt: string | null;
  steps: Array<Omit<UpdateStep, 'id'> & { id: RepairStepId }>;
  log: UpdateLogLine[];
  progress?: UpdateProgress | null;
  stall?: UpdateStall | null;
  /** Why the repair failed or needs the owner, in one sentence. */
  reason: string | null;
  outcome: RepairOutcome | null;
  /** The one sentence shown above the steps (the copy table in the spec). */
  headline: string | null;
  /** Behind "?": one line per action taken, then "N of M parts running", then "Checked N min ago" while waiting. */
  details: string[];
  /** When the share was last probed (waiting only). */
  checkedAt: string | null;
}

/**
 * running   up, and healthy when it has a health check
 * starting  restarting, or up with its health check still starting
 * stopped   exited
 * stuck     created, removing or dead, or Docker did not answer in time
 * missing   the service has no container
 */
export type PartRunState = 'running' | 'starting' | 'stopped' | 'stuck' | 'missing';

/** One part of the install in /v1/status, by compose service name. */
export interface PartState {
  service: string;
  state: PartRunState;
  /** The container's health status, when it has a health check. */
  health: string | null;
}

/**
 * After a successful update the updater replaces its own container with one
 * on the new updater image. From the moment it hands over until the
 * replacement is up and reports `expectedVersion`, it refuses to start a run
 * (409): the old process would be killed in the middle of it.
 */
export interface UpdaterSelfReplace {
  /** The version the replacement updater must report. */
  expectedVersion: string;
  /** The version of the updater that handed over. */
  fromVersion: string;
  /** The run that ended in the hand-over. */
  runId: string;
  /** When the hand-over began. */
  since: string;
  /** In /v1/status only: the marker's age by the updater's clock, so a reader never compares clocks. */
  ageMs?: number;
}

/** A hand-over older than this is taken as lost: the updater (and the page) stop waiting for it. */
export const SELF_REPLACE_STALE_MS = 10 * 60_000;

/** What the updater says about itself (GET /v1/status on the updater). */
export interface UpdaterStatus {
  /** The updater's own build. */
  version: string;
  /** TAGAVE_VERSION in the install's .env. */
  configuredVersion: string | null;
  /** TAGAVE_ROLE in .env: all, app or files. */
  role: string | null;
  /** The services an update restarts, in this install. */
  services: string[];
  run: UpdateRun | null;
  /** Set while the updater restarts itself on a new version (absent from updaters before 0.9). */
  selfReplace?: UpdaterSelfReplace | null;
  /** Each service's state, read with short limits so a stuck part never holds the status (absent from older updaters). */
  parts?: PartState[];
  /** The last repair, if any (absent from older updaters). */
  repair?: RepairRun | null;
}

/** GET /api/v1/updater: the page's view of the updater. */
export interface UpdaterView {
  /** TAGAVE_UPDATER_URL is set: the updater is part of this install. */
  installed: boolean;
  /** It answered (and accepted the app's signature). */
  reachable: boolean;
  /** Why it did not answer, when installed but unreachable. */
  error: string | null;
  updater: UpdaterStatus | null;
  /**
   * The last run succeeded and the app runs its target: nothing left to look
   * at, so the page drops the run without a Done (absent from apps before 0.10.1).
   */
  runSettled?: boolean;
}

/** A release number, optionally with a pre-release suffix: 0.8.0, 0.8.0-rc.1. */
export const UPDATE_TARGET_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,40})?$/;

export const startUpdateSchema = z.object({
  version: z.string().regex(UPDATE_TARGET_RE, 'a release number such as 0.8.0'),
}).strict();
export type StartUpdate = z.infer<typeof startUpdateSchema>;

/** Step-up: how long a sign-in or a re-verification counts as fresh for a one-time action. */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

export type StepUpMethod = 'passkey' | 'totp' | 'oidc' | 'password';

/** GET /api/v1/auth/step-up */
export interface StepUpStatus {
  /** The last strong verification of this session (sign-in or re-verify). */
  verifiedAt: string;
  /** Until when a one-time action goes through without asking again. */
  freshUntil: string;
  fresh: boolean;
  /** Methods this account can re-verify with, strongest first. */
  methods: StepUpMethod[];
  /** The login service's name, when `oidc` is one of the methods. */
  oidcName?: string | null;
}
