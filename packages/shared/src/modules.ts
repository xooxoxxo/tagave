/**
 * Optional modules (Settings › Modules) and the signed release manifest
 * they come from. Shapes only, shared by the updater, the api and the web
 * app; the updater reads and checks the manifest itself
 * (packages/updater/src/release.ts) and needs nothing from here at runtime.
 *
 * Every release publishes `release-manifest.json` and its signature
 * (`release-manifest.json.sig`). The manifest pins every image the release
 * runs, tagave's own and the third-party ones (Postgres, Navidrome), to a
 * digest per architecture, and carries the module catalogue: the optional
 * parts an install can turn on and off. Only modules in the signed official
 * catalogue can be installed; there are no third-party modules.
 */
import { z } from 'zod';
import type { UpdateLogLine, UpdateRunStatus, UpdateStepStatus } from './updater.js';

/** One image of a release. */
export interface ReleaseImage {
  /** The reference as published, with its tag: ghcr.io/xooxoxxo/tagave-app:0.10.0, deluan/navidrome:0.64.0. */
  ref: string;
  /** The .env key that pins it (TAGAVE_DIGEST_APP), read by compose.yml; null for an image only a module's own compose file uses. */
  env: string | null;
  /** The digest of the multi-architecture index, for reference. */
  index: string | null;
  /** The image for each platform ("linux/amd64"), by digest. This is what is pulled. */
  platforms: Record<string, string>;
  /** The services of compose.yml that run it (empty for a module's own image). */
  services: string[];
}

/**
 * A setting a module needs in .env.
 *   secret  32 random bytes as hex, generated the first time and kept (also when the module is turned off)
 *   value   a fixed value; `clearOnDisable` empties it again when the module is turned off
 *   port    a port on this computer; the one already in .env wins, else `default`
 */
export type ModuleSetting =
  | { key: string; kind: 'secret' }
  | { key: string; kind: 'value'; value: string; clearOnDisable?: boolean }
  | { key: string; kind: 'port'; default: number };

/** A module's entry in the catalogue. */
export interface ModuleEntry {
  /** Lower-case letters, digits and dashes: player. */
  id: string;
  name: string;
  /** One line: what it adds. */
  purpose: string;
  /** The oldest tagave release this entry runs with. */
  minVersion: string;
  /** The compose profile that turns its services on. */
  profile: string;
  /** Its compose services and the image (a key of `images`) each runs. */
  services: Array<{ name: string; image: string }>;
  /**
   * Its compose services, when compose.yml does not have them: written to
   * modules/<id>.yml in the install folder (and to COMPOSE_FILE) with every
   * image pinned by digest. null: compose.yml has the services already.
   */
  compose: { services: Record<string, Record<string, unknown>>; volumes?: Record<string, Record<string, unknown> | null> } | null;
  settings: ModuleSetting[];
  /** Services restarted after its settings change, because they read them (the app reads TAGAVE_PLAYER_URL). */
  restarts: string[];
  /** Compose volumes (names in the compose file) that hold its data. */
  volumes: string[];
  /** What stays when it is turned off, in one line. */
  keepsOnRemoval: string;
  estimate: { memoryMb: number; diskMb: number };
  /** The install roles it runs on: "all" (one computer) and/or "app" (the app computer of a split install). */
  roles: Array<'all' | 'app'>;
}

export interface ReleaseManifest {
  schema: 1;
  project: 'tagave';
  version: string;
  publishedAt: string;
  commit: string;
  /** Keyed by a short name: app, worker, updater, postgres, player… */
  images: Record<string, ReleaseImage>;
  modules: ModuleEntry[];
  /** sha256 (hex) of the release's files: install-tagave.sh, compose.yml, compose.db-published.yml. */
  files: Record<string, string>;
}

// -- module operations (the updater runs them) --------------------------------

export const MODULE_ENABLE_STEPS = ['preflight', 'config', 'start', 'verify', 'rollback'] as const;
export const MODULE_DISABLE_STEPS = ['preflight', 'stop', 'config', 'verify', 'data', 'rollback'] as const;
export type ModuleStepId = (typeof MODULE_ENABLE_STEPS)[number] | (typeof MODULE_DISABLE_STEPS)[number];

export interface ModuleStep {
  id: ModuleStepId;
  label: string;
  status: UpdateStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * One Turn on or Turn off, with the same statuses as an update:
 * failed = stopped before anything changed; rolled_back = the install is as
 * it was before; rollback_failed = it is not, and the reason says what to do.
 */
export interface ModuleRun {
  id: string;
  kind: 'module';
  module: string;
  moduleName: string;
  action: 'enable' | 'disable';
  /** Turn off only: the owner chose to delete the module's data too. */
  deleteData: boolean;
  /** The release whose signed catalogue this run follows. */
  version: string;
  status: UpdateRunStatus;
  startedAt: string;
  finishedAt: string | null;
  steps: ModuleStep[];
  log: UpdateLogLine[];
  reason: string | null;
}

/**
 * off             not turned on
 * installing      being turned on now
 * removing        being turned off now
 * on              its profile is on
 * failed          the last Turn on failed (it is off again)
 * update_pending  on, but runs another image than this release pins (an update or `docker compose up -d` brings it in line)
 */
export type ModuleState = 'off' | 'installing' | 'removing' | 'on' | 'failed' | 'update_pending';

export interface ModuleStatus {
  id: string;
  name: string;
  purpose: string;
  state: ModuleState;
  estimate: { memoryMb: number; diskMb: number };
  keepsOnRemoval: string;
  roles: Array<'all' | 'app'>;
  /** Download size of its images for this computer, compressed, when the registry said (null: unknown). */
  downloadBytes: number | null;
  /** False when it cannot be turned on here; `reason` says why (a split install's music computer, an older release). */
  available: boolean;
  reason: string | null;
  /** The last run's failure reason, for `failed`. */
  lastError: string | null;
}

/** What the updater answers on GET /v1/modules. */
export interface UpdaterModules {
  /** TAGAVE_VERSION here. */
  version: string | null;
  /** The signed manifest of that version is here and checks out. */
  verified: boolean;
  /** Why not, when it is not. */
  problem: string | null;
  modules: ModuleStatus[];
  run: ModuleRun | null;
}

/** GET /api/v1/modules: the page's view. */
export interface ModulesView {
  /**
   * updater      the updater runs: Turn on / Turn off work from here
   * command      no updater: the page shows the install-tagave.sh command
   * unreachable  the updater is configured but does not answer
   */
  mode: 'updater' | 'command' | 'unreachable';
  error: string | null;
  version: string | null;
  verified: boolean;
  problem: string | null;
  modules: ModuleStatus[];
  run: ModuleRun | null;
  /** The install role (all, app, files), for the commands. */
  role: string | null;
}

export const MODULE_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;

export const moduleActionSchema = z.object({
  /** Turn off only: also delete the module's data (its volumes). */
  deleteData: z.boolean().optional(),
}).strict();
export type ModuleAction = z.infer<typeof moduleActionSchema>;

/** The shell command that does the same as the button, for installs without the updater. */
export function moduleCommand(action: 'enable' | 'disable', id: string): string {
  return `./install-tagave.sh ${action}-module ${id}`;
}

/** Where a release's signed files are published: <base>/v<version>/<file>. */
export const DEFAULT_RELEASE_ASSETS_URL = 'https://github.com/xooxoxxo/tagave/releases/download';
export const MANIFEST_FILE = 'release-manifest.json';
export const MANIFEST_SIGNATURE_FILE = 'release-manifest.json.sig';
