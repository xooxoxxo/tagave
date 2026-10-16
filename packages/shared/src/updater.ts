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
 */
export type UpdateRunStatus = 'running' | 'succeeded' | 'failed' | 'rolled_back' | 'rollback_failed' | 'interrupted';

export interface UpdateRollback {
  /** The TAGAVE_VERSION put back in .env. */
  version: string;
  /** The new version had applied database migrations, so the backup was restored. */
  restoredDatabase: boolean;
  /** The old version answered healthy afterwards. */
  healthy: boolean;
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
}

/** A release number, optionally with a pre-release suffix: 0.8.0, 0.8.0-rc.1. */
export const UPDATE_TARGET_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,40})?$/;

export const startUpdateSchema = z.object({
  version: z.string().regex(UPDATE_TARGET_RE, 'a release number such as 0.8.0'),
}).strict();
export type StartUpdate = z.infer<typeof startUpdateSchema>;

/** Step-up: how long a sign-in or a re-verification counts as fresh for a one-time action. */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

export type StepUpMethod = 'passkey' | 'totp' | 'password';

/** GET /api/v1/auth/step-up */
export interface StepUpStatus {
  /** The last strong verification of this session (sign-in or re-verify). */
  verifiedAt: string;
  /** Until when a one-time action goes through without asking again. */
  freshUntil: string;
  fresh: boolean;
  /** Methods this account can re-verify with, strongest first. */
  methods: StepUpMethod[];
}
