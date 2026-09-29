import { describe, it, expect } from 'vitest';
import { DEFAULT_RELEASES_URL, UPDATE_CHECK_INTERVAL_MS, type ReleaseNote } from '@liner/shared';
import { buildStatus, checkDue, detectInstall, effectiveFeed, toReleaseNote, type UpdatesSettings } from './updatesFeed.js';

const app = { version: '0.4.1', sha: 'abc1234', builtAt: null, source: 'env' as const };
const install = { method: 'compose' as const, role: null };

function release(version: string, extra: Partial<ReleaseNote> = {}): ReleaseNote {
  return { tag: `v${version}`, version, name: null, body: null, publishedAt: null, url: null, prerelease: false, requiresAttention: false, ...extra };
}

function checked(releases: ReleaseNote[], at = new Date().toISOString(), url = DEFAULT_RELEASES_URL): NonNullable<UpdatesSettings['lastCheck']> {
  return { at, url, etag: null, releases, error: null };
}

describe('effectiveFeed', () => {
  it('is on and points at the official releases by default', () => {
    expect(effectiveFeed({}, undefined)).toEqual({ url: DEFAULT_RELEASES_URL, enabled: true, custom: false, lockedByServer: false });
    expect(effectiveFeed({ feedUrl: null }, '')).toMatchObject({ url: DEFAULT_RELEASES_URL, enabled: true });
  });

  it('can be turned off or pointed elsewhere by the owner', () => {
    expect(effectiveFeed({ enabled: false }, undefined)).toMatchObject({ url: null, enabled: false });
    expect(effectiveFeed({ feedUrl: 'https://api.github.com/repos/me/fork/releases' }, undefined))
      .toMatchObject({ url: 'https://api.github.com/repos/me/fork/releases', enabled: true, custom: true });
  });

  it('ignores a stored library feed that is not a GitHub releases URL', () => {
    for (const feedUrl of ['https://10.0.0.5/admin', 'https://localhost/releases', 'https://api.github.com.evil.test/repos/a/b/releases', 'https://api.github.com/repos/a/b/releases?x=1']) {
      expect(effectiveFeed({ feedUrl }, undefined)).toMatchObject({ url: DEFAULT_RELEASES_URL, custom: false });
    }
  });

  it('lets TAGAVE_UPDATE_FEED override the library', () => {
    expect(effectiveFeed({ enabled: true }, 'off')).toEqual({ url: null, enabled: false, custom: false, lockedByServer: true });
    expect(effectiveFeed({ enabled: false }, 'https://example.test/releases'))
      .toEqual({ url: 'https://example.test/releases', enabled: true, custom: true, lockedByServer: true });
  });
});

describe('checkDue', () => {
  const feed = effectiveFeed({}, undefined);
  const now = Date.parse('2026-09-29T12:00:00Z');

  it('is due when never checked', () => {
    expect(checkDue({}, feed, now)).toBe(true);
  });

  it('waits 12 hours between automatic checks', () => {
    const recent = { lastCheck: checked([], new Date(now - UPDATE_CHECK_INTERVAL_MS + 60_000).toISOString()) };
    const old = { lastCheck: checked([], new Date(now - UPDATE_CHECK_INTERVAL_MS).toISOString()) };
    expect(checkDue(recent, feed, now)).toBe(false);
    expect(checkDue(old, feed, now)).toBe(true);
  });

  it('never runs when checks are off', () => {
    expect(checkDue({ enabled: false }, effectiveFeed({ enabled: false }, undefined), now)).toBe(false);
  });

  it('starts over when the feed URL changed', () => {
    const other = { lastCheck: checked([], new Date(now).toISOString(), 'https://example.test/old') };
    expect(checkDue(other, feed, now)).toBe(true);
  });
});

describe('toReleaseNote', () => {
  it('reads a GitHub release and its requires-attention marker', () => {
    expect(toReleaseNote({ tag_name: 'v0.5.0', name: '0.5.0', body: 'Requires attention: read this', html_url: 'https://x', prerelease: false, labels: [] }))
      .toMatchObject({ version: '0.5.0', requiresAttention: true, url: 'https://x' });
    expect(toReleaseNote({ tag_name: 'v0.5.0', labels: [{ name: 'requires-attention' }] })).toMatchObject({ requiresAttention: true });
    expect(toReleaseNote({ tag_name: 'v0.5.0', body: 'fixes' })).toMatchObject({ requiresAttention: false });
  });

  it('skips drafts and junk', () => {
    expect(toReleaseNote({ tag_name: 'v1', draft: true })).toBeNull();
    expect(toReleaseNote(null)).toBeNull();
    expect(toReleaseNote({ name: 'no tag' })).toBeNull();
  });
});

describe('detectInstall', () => {
  it('trusts TAGAVE_INSTALL_METHOD first', () => {
    expect(detectInstall({ TAGAVE_INSTALL_METHOD: 'Portainer', TAGAVE_ROLE: 'all' }, { source: 'env' })).toEqual({ method: 'portainer', role: 'all' });
  });

  it('infers installer, source and compose', () => {
    expect(detectInstall({ TAGAVE_ROLE: 'app' }, { source: 'env' })).toEqual({ method: 'installer', role: 'app' });
    expect(detectInstall({}, { source: 'git' })).toEqual({ method: 'source', role: null });
    expect(detectInstall({}, { source: 'deployed-file' })).toEqual({ method: 'source', role: null });
    expect(detectInstall({}, { source: 'env' })).toEqual({ method: 'compose', role: null });
    expect(detectInstall({ TAGAVE_INSTALL_METHOD: 'nonsense' }, { source: 'unknown' })).toEqual({ method: 'unknown', role: null });
  });
});

describe('buildStatus', () => {
  const base = { serverFeed: undefined, app, install, workers: [] };

  it('reports newer stable releases as an update', () => {
    const s = buildStatus({ ...base, updates: { lastCheck: checked([release('0.6.0-rc.1', { prerelease: true }), release('0.5.0'), release('0.4.1')]) } });
    expect(s.updateAvailable).toBe(true);
    expect(s.feed.newer.map((r) => r.version)).toEqual(['0.5.0']);
    expect(s.feed.latest?.version).toBe('0.5.0');
    expect(s.feed.enabled).toBe(true);
    expect(s.install).toEqual(install);
  });

  it('hides the badge for a skipped version until a newer one appears', () => {
    const skipped = buildStatus({ ...base, updates: { skippedVersion: '0.5.0', lastCheck: checked([release('0.5.0')]) } });
    expect(skipped.updateAvailable).toBe(false);
    expect(skipped.feed.newer).toHaveLength(1);
    expect(skipped.feed.skippedVersion).toBe('0.5.0');
    const newer = buildStatus({ ...base, updates: { skippedVersion: '0.5.0', lastCheck: checked([release('0.5.1'), release('0.5.0')]) } });
    expect(newer.updateAvailable).toBe(true);
  });

  it('shows nothing when checks are off', () => {
    const s = buildStatus({ ...base, updates: { enabled: false, lastCheck: checked([release('0.5.0')]) } });
    expect(s.updateAvailable).toBe(false);
    expect(s.feed.newer).toEqual([]);
    expect(s.feed.nextCheckAt).toBeNull();
  });

  it('schedules the next automatic check 12 hours after the last', () => {
    const at = '2026-09-29T00:00:00.000Z';
    const s = buildStatus({ ...base, updates: { lastCheck: checked([], at) } });
    expect(s.feed.nextCheckAt).toBe('2026-09-29T12:00:00.000Z');
  });
});
