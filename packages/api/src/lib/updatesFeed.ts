/**
 * Pure parts of Settings › Updates: which feed a library checks, whether a
 * check is due, what a GitHub Releases item means, how this server was
 * installed, and the status the page renders. The route file does the I/O.
 *
 * Privacy: a check is one unauthenticated GET to the feed URL with a fixed
 * User-Agent. No version, id, contact or library data is sent.
 */
import {
  DEFAULT_RELEASES_URL, UPDATE_CHECK_INTERVAL_MS, compareVersions, installMethodSchema,
  type BuildInfoView, type InstallInfo, type ReleaseNote, type UpdatesStatus, type WorkerVersion,
} from '@liner/shared';

/** GitHub asks for a User-Agent; this one names the app and nothing else. */
export const FEED_USER_AGENT = 'tagave-update-check';

/** Stored under libraries.settings.updates. */
export interface UpdatesSettings {
  /** false turns checks off. Unset means on (the default). */
  enabled?: boolean;
  /** A replacement feed URL. Unset or null means the official feed. */
  feedUrl?: string | null;
  skippedVersion?: string | null;
  lastCheck?: {
    at: string;
    /** The URL this check read; a different feed starts over. */
    url?: string;
    etag: string | null;
    releases: ReleaseNote[];
    error: string | null;
  } | null;
}

export interface EffectiveFeed {
  url: string | null;
  enabled: boolean;
  custom: boolean;
  lockedByServer: boolean;
}

/**
 * TAGAVE_UPDATE_FEED, when set, wins: "off" (or false/0/no) turns checks off
 * for every library, a URL replaces the official feed. Otherwise the
 * library's own choice, and the official feed when it made none.
 */
export function effectiveFeed(updates: UpdatesSettings, serverSetting: string | undefined): EffectiveFeed {
  const server = serverSetting?.trim();
  if (server) {
    if (/^(off|false|0|no|none|disabled?)$/i.test(server)) return { url: null, enabled: false, custom: false, lockedByServer: true };
    return { url: server, enabled: true, custom: server !== DEFAULT_RELEASES_URL, lockedByServer: true };
  }
  if (updates.enabled === false) return { url: null, enabled: false, custom: !!updates.feedUrl, lockedByServer: false };
  const url = updates.feedUrl || DEFAULT_RELEASES_URL;
  return { url, enabled: true, custom: url !== DEFAULT_RELEASES_URL, lockedByServer: false };
}

/** Releases read from a different URL than the one in force do not count. */
function currentCheck(updates: UpdatesSettings, feed: EffectiveFeed) {
  const check = updates.lastCheck ?? null;
  if (!check || !feed.url) return null;
  // Checks stored before the URL was recorded belong to whatever feed was set then.
  if (check.url !== undefined && check.url !== feed.url) return null;
  return check;
}

/** An automatic check is due when checks are on and the last one is 12 h old (or never ran). */
export function checkDue(updates: UpdatesSettings, feed: EffectiveFeed, now: number): boolean {
  if (!feed.enabled || !feed.url) return false;
  const check = currentCheck(updates, feed);
  if (!check) return true;
  const at = Date.parse(check.at);
  return !Number.isFinite(at) || now - at >= UPDATE_CHECK_INTERVAL_MS;
}

/** GitHub Releases API item → ReleaseNote; unknown shapes and drafts are skipped. */
export function toReleaseNote(raw: unknown): ReleaseNote | null {
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

/**
 * How this server was installed. TAGAVE_INSTALL_METHOD (set by the compose
 * files and the platform templates) wins; otherwise TAGAVE_ROLE means the
 * installer wrote the .env, a git checkout or DEPLOYED file means a source
 * install, and version env baked into the image means a published image.
 */
export function detectInstall(env: NodeJS.ProcessEnv, build: Pick<BuildInfoView, 'source'>): InstallInfo {
  const roleRaw = env['TAGAVE_ROLE']?.trim();
  const role = roleRaw === 'all' || roleRaw === 'app' || roleRaw === 'files' ? roleRaw : null;
  const explicit = installMethodSchema.safeParse(env['TAGAVE_INSTALL_METHOD']?.trim().toLowerCase());
  if (explicit.success) return { method: explicit.data, role };
  if (role) return { method: 'installer', role };
  if (build.source === 'git' || build.source === 'deployed-file') return { method: 'source', role };
  if (build.source === 'env') return { method: 'compose', role };
  return { method: 'unknown', role };
}

export function buildStatus(input: {
  updates: UpdatesSettings;
  serverFeed: string | undefined;
  app: BuildInfoView;
  install: InstallInfo;
  workers: WorkerVersion[];
}): UpdatesStatus {
  const { updates, app, workers } = input;
  const feed = effectiveFeed(updates, input.serverFeed);
  const check = currentCheck(updates, feed);
  const releases = feed.enabled ? check?.releases ?? [] : [];
  const newer = releases.filter((r) => !r.prerelease && compareVersions(r.version, app.version) > 0);
  const latest = releases.find((r) => !r.prerelease) ?? null;
  const skipped = updates.skippedVersion ?? null;
  const unskipped = newer.filter((r) => !skipped || compareVersions(r.version, skipped) > 0);
  const mismatch = workers.some((w) => w.sha && app.sha && w.sha !== app.sha);
  const nextCheckAt = !feed.enabled ? null
    : check ? new Date(Date.parse(check.at) + UPDATE_CHECK_INTERVAL_MS).toISOString()
    : new Date().toISOString();
  return {
    app,
    install: input.install,
    workers,
    mismatch,
    updateAvailable: unskipped.length > 0,
    feed: {
      url: feed.url,
      defaultUrl: DEFAULT_RELEASES_URL,
      custom: feed.custom,
      enabled: feed.enabled,
      lockedByServer: feed.lockedByServer,
      lastCheckedAt: check?.at ?? null,
      nextCheckAt,
      latest,
      newer,
      skippedVersion: skipped,
      error: feed.enabled ? check?.error ?? null : null,
    },
  };
}
