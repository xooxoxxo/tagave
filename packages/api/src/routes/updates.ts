/**
 * Settings › Updates (spec PLT-5, XO-313): what is running where, whether
 * a newer release exists, and its notes. Checks are on by default against
 * the official GitHub releases (DEFAULT_RELEASES_URL); the owner can turn
 * them off, use another feed, or skip a version, and TAGAVE_UPDATE_FEED
 * ("off" or a URL) overrides that for the whole server. The server checks
 * on its own at most every 12 hours (startUpdateChecks). A check is one GET
 * to the feed; nothing about this server is sent. Nothing here performs an
 * update: the page shows the command for the way this server was installed.
 */
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { libraries } from '@liner/db';
import { readBuildInfo } from '@liner/core';
import {
  compareVersions, isGithubReleasesUrl, setUpdatesFeedSchema, skipUpdateSchema,
  type ReleaseNote, type WorkerVersion,
} from '@liner/shared';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';
import {
  FEED_USER_AGENT, buildStatus, checkDue, detectInstall, effectiveFeed, toReleaseNote,
  type UpdatesSettings,
} from '../lib/updatesFeed.js';

/** Workers that reported within this window count as live (matches the doctor). */
const LIVE_WINDOW_SECONDS = 120;
const FEED_TIMEOUT_MS = 10_000;
const KEEP_RELEASES = 20;
/** "Check now" is not throttled to 12 h, but a double click does not fetch twice. */
const MANUAL_MIN_GAP_MS = 30_000;
/** How often the background timer looks for libraries whose check is due. */
const SCHEDULER_TICK_MS = 3600_000;
const SCHEDULER_FIRST_DELAY_MS = 60_000;

const serverFeed = () => process.env['TAGAVE_UPDATE_FEED'];

async function loadLibrary(userId: string, libraryId: string) {
  const rows = await getDb()
    .select({ id: libraries.id, settings: libraries.settings })
    .from(libraries)
    .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, userId)));
  if (!rows[0]) throw new ApiError(404, 'Not Found', 'Library not found');
  const settings = (typeof rows[0].settings === 'string' ? JSON.parse(rows[0].settings) : rows[0].settings ?? {}) as Record<string, unknown>;
  return { id: rows[0].id, settings, updates: (settings['updates'] ?? {}) as UpdatesSettings };
}

/**
 * Merge `patch` into settings.updates and return the updates as stored now.
 * Each write names only the fields it changes, so a feed check that takes up
 * to FEED_TIMEOUT_MS and an owner's change made meanwhile (checks off, a
 * skipped version, a new feed) do not undo each other.
 */
async function patchUpdates(libraryId: string, patch: Partial<UpdatesSettings>): Promise<UpdatesSettings> {
  const rows = (await getDb().execute(sql`
    update libraries set settings = jsonb_set(
      coalesce(settings, '{}'::jsonb),
      '{updates}',
      coalesce(settings->'updates', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)
    where id = ${libraryId}
    returning settings->'updates' as updates`)) as unknown as Array<{ updates: UpdatesSettings | string | null }>;
  const raw = rows[0]?.updates ?? null;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw ?? patch) as UpdatesSettings;
}

async function liveWorkers(): Promise<WorkerVersion[]> {
  const rows = (await getDb().execute(sql`
    select info as progress, seen_at as created_at
    from worker_heartbeats
    where seen_at > now() - make_interval(secs => ${LIVE_WINDOW_SECONDS})
    order by worker_id`)) as unknown as Array<{ progress: Record<string, unknown>; created_at: Date | string }>;
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

async function fetchFeed(url: string, etag: string | null): Promise<{ status: 'fresh'; etag: string | null; releases: ReleaseNote[] } | { status: 'unchanged' }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': FEED_USER_AGENT,
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

function status(updates: UpdatesSettings, workers: WorkerVersion[]) {
  const app = readBuildInfo();
  return buildStatus({ updates, serverFeed: serverFeed(), app, install: detectInstall(process.env, app), workers });
}

/** Fetch the feed in force for one library and store the result (errors are stored, not thrown). */
async function checkLibrary(libraryId: string, updates: UpdatesSettings): Promise<UpdatesSettings> {
  const feed = effectiveFeed(updates, serverFeed());
  if (!feed.url) return updates;
  const previous = updates.lastCheck && (updates.lastCheck.url === undefined || updates.lastCheck.url === feed.url) ? updates.lastCheck : null;
  const at = new Date().toISOString();
  let lastCheck: NonNullable<UpdatesSettings['lastCheck']>;
  try {
    const result = await fetchFeed(feed.url, previous?.etag ?? null);
    lastCheck = result.status === 'unchanged'
      ? { at, url: feed.url, etag: previous?.etag ?? null, releases: previous?.releases ?? [], error: null }
      : { at, url: feed.url, etag: result.etag, releases: result.releases, error: null };
  } catch (err) {
    lastCheck = { at, url: feed.url, etag: previous?.etag ?? null, releases: previous?.releases ?? [], error: (err as Error).message };
  }
  return patchUpdates(libraryId, { lastCheck });
}

/**
 * Background check: every hour, each library whose feed is on and whose last
 * check is 12 hours old is checked once. Returns a stop function.
 */
export function startUpdateChecks(logger: FastifyBaseLogger): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const rows = await getDb().select({ id: libraries.id, settings: libraries.settings }).from(libraries);
      const now = Date.now();
      for (const row of rows) {
        const settings = (typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings ?? {}) as Record<string, unknown>;
        const updates = (settings['updates'] ?? {}) as UpdatesSettings;
        if (!checkDue(updates, effectiveFeed(updates, serverFeed()), now)) continue;
        const next = await checkLibrary(row.id, updates);
        if (next.lastCheck?.error) logger.warn({ libraryId: row.id, error: next.lastCheck.error }, 'update check failed');
      }
    } catch (err) {
      logger.warn({ err }, 'update check skipped');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => { void tick(); }, SCHEDULER_FIRST_DELAY_MS);
  const every = setInterval(() => { void tick(); }, SCHEDULER_TICK_MS);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}

export async function createUpdateRoutes(fastify: FastifyInstance) {
  fastify.get('/libraries/:libraryId/updates', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const lib = await loadLibrary(request.user.id, libraryId);
    reply.send(status(lib.updates, await liveWorkers()));
  });

  /** Turn checks on or off, or replace the feed URL (null: the official feed). */
  fastify.put('/libraries/:libraryId/updates/feed', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const lib = await loadLibrary(request.user.id, libraryId);
    const parsed = setUpdatesFeedSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'Invalid body');
    // The server fetches this URL on its own every 12 h, so a library owner
    // may only name a GitHub releases list; TAGAVE_UPDATE_FEED can be anything.
    if (parsed.data.url && !isGithubReleasesUrl(parsed.data.url)) {
      throw new ApiError(400, 'Bad Request', 'The feed must be a GitHub releases API URL: https://api.github.com/repos/OWNER/REPO/releases');
    }
    const patch: Partial<UpdatesSettings> = {};
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
    if (parsed.data.url !== undefined) patch.feedUrl = parsed.data.url;
    const next = await patchUpdates(lib.id, patch);
    reply.send(status(next, await liveWorkers()));
  });

  /** "Skip this version": no update badge until a release newer than it appears. */
  fastify.put('/libraries/:libraryId/updates/skip', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const lib = await loadLibrary(request.user.id, libraryId);
    const parsed = skipUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'Invalid body');
    const next = await patchUpdates(lib.id, { skippedVersion: parsed.data.version ? parsed.data.version.replace(/^v/i, '') : null });
    reply.send(status(next, await liveWorkers()));
  });

  /** Check the feed now (ETag-cached). */
  fastify.post('/libraries/:libraryId/updates/check', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const lib = await loadLibrary(request.user.id, libraryId);
    const feed = effectiveFeed(lib.updates, serverFeed());
    if (!feed.enabled || !feed.url) throw new ApiError(409, 'Conflict', 'Update checks are turned off');
    const last = lib.updates.lastCheck;
    const recent = last && last.url === feed.url && !last.error && Date.now() - Date.parse(last.at) < MANUAL_MIN_GAP_MS;
    const next = recent ? lib.updates : await checkLibrary(libraryId, lib.updates);
    reply.send(status(next, await liveWorkers()));
  });
}
