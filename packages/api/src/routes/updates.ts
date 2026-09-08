/**
 * Settings › Updates (spec PLT-5, XO-313): what is running where, whether
 * a newer release exists, and its notes. The feed is a GitHub Releases API
 * URL kept in library settings (`updates.feedUrl`); until the repository is
 * published it stays unset and the page explains why. Nothing here performs
 * an update — the mechanism is the per-host instructions the page renders
 * (docker-tag self-update arrives with the XO-296 cutover).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { libraries } from '@liner/db';
import { readBuildInfo } from '@liner/core';
import {
  compareVersions, setUpdatesFeedSchema,
  type ReleaseNote, type UpdatesStatus, type WorkerVersion,
} from '@liner/shared';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

/** Workers that reported within this window count as live (matches the doctor). */
const LIVE_WINDOW_SECONDS = 120;
const FEED_TIMEOUT_MS = 10_000;
const KEEP_RELEASES = 20;

interface UpdatesSettings {
  feedUrl?: string | null;
  lastCheck?: {
    at: string;
    etag: string | null;
    releases: ReleaseNote[];
    error: string | null;
  } | null;
}

async function loadLibrary(userId: string, libraryId: string) {
  const rows = await getDb()
    .select({ id: libraries.id, settings: libraries.settings })
    .from(libraries)
    .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, userId)));
  if (!rows[0]) throw new ApiError(404, 'Not Found', 'Library not found');
  const settings = (typeof rows[0].settings === 'string' ? JSON.parse(rows[0].settings) : rows[0].settings ?? {}) as Record<string, unknown>;
  return { id: rows[0].id, settings, updates: (settings['updates'] ?? {}) as UpdatesSettings };
}

async function saveUpdates(libraryId: string, updates: UpdatesSettings): Promise<void> {
  // jsonb concatenation merges at the top level, so the other settings keys survive.
  await getDb().execute(sql`
    update libraries set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ updates })}::jsonb
    where id = ${libraryId}`);
}

async function liveWorkers(): Promise<WorkerVersion[]> {
  const rows = (await getDb().execute(sql`
    select distinct on (progress->>'workerId') progress, created_at
    from job_runs
    where type = 'worker.heartbeat' and created_at > now() - make_interval(secs => ${LIVE_WINDOW_SECONDS})
    order by progress->>'workerId', created_at desc`)) as unknown as Array<{ progress: Record<string, unknown>; created_at: Date | string }>;
  return rows.map((r) => {
    const p = r.progress ?? {};
    return {
      workerId: String(p['workerId'] ?? 'unknown'),
      version: typeof p['version'] === 'string' ? p['version'] : null,
      sha: typeof p['sha'] === 'string' ? p['sha'] : null,
      builtAt: typeof p['builtAt'] === 'string' ? p['builtAt'] : null,
      queues: Array.isArray(p['queues']) ? (p['queues'] as unknown[]).map(String) : [],
      host: typeof p['host'] === 'string' ? p['host'] : null,
      lastSeenAt: new Date(r.created_at).toISOString(),
      loopLagMs: typeof p['loopLagMs'] === 'number' ? p['loopLagMs'] : null,
    };
  });
}

/** GitHub Releases API item → ReleaseNote; unknown shapes are skipped. */
function toReleaseNote(raw: unknown): ReleaseNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tag = typeof r['tag_name'] === 'string' ? r['tag_name'] : null;
  if (!tag || r['draft'] === true) return null;
  const labels = Array.isArray(r['labels']) ? (r['labels'] as Array<{ name?: string }>).map((l) => l?.name ?? '') : [];
  const body = typeof r['body'] === 'string' ? r['body'] : null;
  return {
    tag,
    version: tag.replace(/^v/i, ''),
    name: typeof r['name'] === 'string' ? r['name'] : null,
    body,
    publishedAt: typeof r['published_at'] === 'string' ? r['published_at'] : null,
    url: typeof r['html_url'] === 'string' ? r['html_url'] : null,
    prerelease: r['prerelease'] === true,
    requiresAttention: labels.includes('requires-attention') || /requires[- ]attention/i.test(body ?? ''),
  };
}

async function fetchFeed(url: string, etag: string | null, userAgent: string): Promise<{ status: 'fresh'; etag: string | null; releases: ReleaseNote[] } | { status: 'unchanged' }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': userAgent,
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
      signal: controller.signal,
    });
    if (res.status === 304) return { status: 'unchanged' };
    if (!res.ok) throw new Error(`feed returned ${res.status}`);
    const json: unknown = await res.json();
    const list = Array.isArray(json) ? json : [json];
    const releases = list.map(toReleaseNote).filter((r): r is ReleaseNote => r !== null)
      .sort((a, b) => compareVersions(b.version, a.version))
      .slice(0, KEEP_RELEASES);
    return { status: 'fresh', etag: res.headers.get('etag'), releases };
  } finally {
    clearTimeout(timer);
  }
}

function buildStatus(updates: UpdatesSettings, workers: WorkerVersion[]): UpdatesStatus {
  const app = readBuildInfo();
  const releases = updates.lastCheck?.releases ?? [];
  const newer = releases.filter((r) => !r.prerelease && compareVersions(r.version, app.version) > 0);
  const latest = releases.find((r) => !r.prerelease) ?? null;
  const mismatch = workers.some((w) => w.sha && app.sha && w.sha !== app.sha);
  return {
    app,
    workers,
    mismatch,
    updateAvailable: newer.length > 0,
    feed: {
      url: updates.feedUrl ?? null,
      enabled: !!updates.feedUrl,
      lastCheckedAt: updates.lastCheck?.at ?? null,
      latest,
      newer,
      error: updates.lastCheck?.error ?? null,
    },
  };
}

export async function createUpdateRoutes(fastify: FastifyInstance) {
  fastify.get('/libraries/:libraryId/updates', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const lib = await loadLibrary(request.user.id, libraryId);
    reply.send(buildStatus(lib.updates, await liveWorkers()));
  });

  /** Set or clear the release feed URL (a GitHub Releases API endpoint). */
  fastify.put('/libraries/:libraryId/updates/feed', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const lib = await loadLibrary(request.user.id, libraryId);
    const parsed = setUpdatesFeedSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'Invalid body');
    const next: UpdatesSettings = { feedUrl: parsed.data.url, lastCheck: parsed.data.url === lib.updates.feedUrl ? lib.updates.lastCheck ?? null : null };
    await saveUpdates(libraryId, next);
    reply.send(buildStatus(next, await liveWorkers()));
  });

  /** Check the feed now (etag-cached; the page also does this daily). */
  fastify.post('/libraries/:libraryId/updates/check', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const lib = await loadLibrary(request.user.id, libraryId);
    if (!lib.updates.feedUrl) throw new ApiError(409, 'Conflict', 'No release feed configured');
    const app = readBuildInfo();
    const contact = typeof lib.settings['contactString'] === 'string' ? ` (+${lib.settings['contactString']})` : '';
    const previous = lib.updates.lastCheck ?? null;
    let next: UpdatesSettings;
    try {
      const result = await fetchFeed(lib.updates.feedUrl, previous?.etag ?? null, `Liner/${app.version}${contact}`);
      next = {
        feedUrl: lib.updates.feedUrl,
        lastCheck: result.status === 'unchanged'
          ? { at: new Date().toISOString(), etag: previous?.etag ?? null, releases: previous?.releases ?? [], error: null }
          : { at: new Date().toISOString(), etag: result.etag, releases: result.releases, error: null },
      };
    } catch (err) {
      next = {
        feedUrl: lib.updates.feedUrl,
        lastCheck: { at: new Date().toISOString(), etag: previous?.etag ?? null, releases: previous?.releases ?? [], error: (err as Error).message },
      };
    }
    await saveUpdates(libraryId, next);
    reply.send(buildStatus(next, await liveWorkers()));
  });
}
