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

export const updatesFeedSchema = z.object({
  url: z.string().nullable().describe('GitHub Releases API URL; null until the repo is published'),
  enabled: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  latest: releaseNoteSchema.nullable(),
  newer: z.array(releaseNoteSchema).describe('Releases newer than the running app, newest first'),
  error: z.string().nullable(),
}).strict();

export const updatesStatusSchema = z.object({
  app: buildInfoSchema,
  workers: z.array(workerVersionSchema),
  mismatch: z.boolean().describe('Some live worker runs a different sha than the app'),
  updateAvailable: z.boolean(),
  feed: updatesFeedSchema,
}).strict();

export type UpdatesStatus = z.infer<typeof updatesStatusSchema>;

export const setUpdatesFeedSchema = z.object({
  url: z.string().url().max(500).nullable(),
}).strict();

export type SetUpdatesFeed = z.infer<typeof setUpdatesFeedSchema>;

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
