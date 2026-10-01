import { z } from 'zod';

/**
 * Build identity and update status (spec PLT-5 / XO-313). Every process
 * reports the same triple; Settings › Updates shows the app next to the
 * workers so a split-host deploy that lags is visible.
 */
export const buildInfoSchema = z.object({
  version: z.string(),
  sha: z.string().nullable(),
  builtAt: z.string().nullable(),
  source: z.enum(['env', 'deployed-file', 'git', 'unknown']),
}).strict();

export type BuildInfoView = z.infer<typeof buildInfoSchema>;

export const workerVersionSchema = z.object({
  workerId: z.string(),
  version: z.string().nullable(),
  sha: z.string().nullable(),
  builtAt: z.string().nullable(),
  queues: z.array(z.string()),
  host: z.string().nullable(),
  lastSeenAt: z.string().datetime(),
  loopLagMs: z.number().nullable(),
}).strict();

export type WorkerVersion = z.infer<typeof workerVersionSchema>;

export const releaseNoteSchema = z.object({
  tag: z.string(),
  version: z.string().describe('tag without a leading v'),
  name: z.string().nullable(),
  body: z.string().nullable().describe('Markdown release notes'),
  publishedAt: z.string().nullable(),
  url: z.string().nullable(),
  prerelease: z.boolean(),
  requiresAttention: z.boolean().describe('Release carries the requires-attention label / marker'),
}).strict();

export type ReleaseNote = z.infer<typeof releaseNoteSchema>;

/**
 * The official release feed. Update checks are on by default and point here;
 * the owner can turn them off or point them at another GitHub Releases API
 * URL (a fork), and the server-wide TAGAVE_UPDATE_FEED env (a URL, or "off")
 * overrides both. A check is one GET to this URL, nothing else is sent.
 */
export const DEFAULT_RELEASES_URL = 'https://api.github.com/repos/xooxoxxo/tagave/releases';

/**
 * A feed the page may set: the releases list of one GitHub repository and
 * nothing else. The server fetches it on its own, so an arbitrary URL would
 * let any library owner make the server call internal addresses. A server
 * admin can still point TAGAVE_UPDATE_FEED anywhere.
 */
export const GITHUB_RELEASES_URL_RE = /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/releases$/;

export function isGithubReleasesUrl(url: string): boolean {
  return GITHUB_RELEASES_URL_RE.test(url) && !/\/\.\.?\//.test(url);
}

/** The server checks the feed on its own at most this often. */
export const UPDATE_CHECK_INTERVAL_MS = 12 * 3600 * 1000;

export const updatesFeedSchema = z.object({
  url: z.string().nullable().describe('The GitHub Releases API URL checked; null when checks are off'),
  defaultUrl: z.string().describe('The official feed'),
  custom: z.boolean().describe('The owner replaced the official feed with another URL'),
  enabled: z.boolean(),
  lockedByServer: z.boolean().describe('TAGAVE_UPDATE_FEED decides the feed; the page cannot change it'),
  lastCheckedAt: z.string().nullable(),
  nextCheckAt: z.string().nullable().describe('Earliest automatic check; null when checks are off'),
  latest: releaseNoteSchema.nullable(),
  newer: z.array(releaseNoteSchema).describe('Releases newer than the running app, newest first'),
  skippedVersion: z.string().nullable().describe('"Skip this version": no badge until something newer than this appears'),
  error: z.string().nullable(),
}).strict();

/**
 * How this server was installed, which decides the update command shown
 * first. The compose files set TAGAVE_INSTALL_METHOD; without it the API
 * infers installer (TAGAVE_ROLE is set), source (git or a DEPLOYED file) or
 * compose (a published image).
 */
export const installMethodSchema = z.enum(['installer', 'compose', 'source', 'portainer', 'dokploy', 'coolify', 'unraid', 'unknown']);
export type InstallMethod = z.infer<typeof installMethodSchema>;

export const installInfoSchema = z.object({
  method: installMethodSchema,
  role: z.enum(['all', 'app', 'files']).nullable().describe('Installer role; "app" means the file worker runs on another computer'),
}).strict();
export type InstallInfo = z.infer<typeof installInfoSchema>;

export const updatesStatusSchema = z.object({
  app: buildInfoSchema,
  install: installInfoSchema,
  workers: z.array(workerVersionSchema),
  mismatch: z.boolean().describe('Some live worker runs a different sha than the app'),
  updateAvailable: z.boolean().describe('A newer stable release exists that the owner has not skipped'),
  feed: updatesFeedSchema,
}).strict();

export type UpdatesStatus = z.infer<typeof updatesStatusSchema>;

export const setUpdatesFeedSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().url().max(500).nullable().optional().describe('null: back to the official feed'),
}).strict();

export type SetUpdatesFeed = z.infer<typeof setUpdatesFeedSchema>;

export const skipUpdateSchema = z.object({
  version: z.string().min(1).max(64).nullable().describe('null: stop skipping'),
}).strict();

export type SkipUpdate = z.infer<typeof skipUpdateSchema>;

/** Numeric dotted compare; a leading "v" and any pre-release suffix are ignored. Returns <0, 0, >0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/i, '').split('-')[0]!.split('.').map((p) => parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
