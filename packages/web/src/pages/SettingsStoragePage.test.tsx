/**
 * Settings › Storage errors say what failed. The page used to say "Only the
 * owner can see this page" for every error, also while the database was down.
 */
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROBLEM_TYPES, type DiskSpaceView, type StorageOverview } from '@tagave/shared';
import { DiskSpace, StorageView, TagChangeCleanupView, storageErrorText } from './SettingsStoragePage';

describe('storageErrorText', () => {
  it('blames permissions only for a 403', () => {
    expect(storageErrorText({ status: 403, title: 'Forbidden', detail: 'Only the owner can see storage' })).toBe('Only the owner can see this page.');
    expect(storageErrorText({ status: 401, title: 'Unauthorized' })).toBe('You are signed out. Sign in again to see this page.');
    for (const e of [{ status: 500 }, { status: 503, type: PROBLEM_TYPES.databaseUnreachable }, new TypeError('Failed to fetch'), undefined]) {
      expect(storageErrorText(e)).not.toMatch(/owner/);
    }
  });

  it('says the database is down, with the server’s detail', () => {
    expect(storageErrorText({ status: 503, type: PROBLEM_TYPES.databaseUnreachable, title: 'Database unreachable', detail: 'The database cannot be reached: it refuses connections (ECONNREFUSED).' }))
      .toBe('Could not measure storage: the database is not answering. The database cannot be reached: it refuses connections (ECONNREFUSED).');
  });

  it('names the step that failed', () => {
    expect(storageErrorText({ status: 500, type: PROBLEM_TYPES.storageMeasurementFailed, title: 'Measurement failed', detail: 'Measuring the backups folder (/backups) failed: EIO' }))
      .toBe('Could not measure storage. Measuring the backups folder (/backups) failed: EIO');
  });

  it('tells a server that does not answer from one that answers with an error', () => {
    expect(storageErrorText(new TypeError('Failed to fetch'))).toMatch(/the server did not answer/);
    expect(storageErrorText({ status: 502, title: 'Bad Gateway' })).toMatch(/not answering \(502\)\. It may be restarting/);
    expect(storageErrorText({ status: 500, title: 'Internal Server Error', detail: 'An unexpected error occurred' })).toBe('Could not measure storage: the server answered 500. An unexpected error occurred');
  });
});

const GB = 1024 ** 3;
const disk = (over: Partial<DiskSpaceView> = {}): DiskSpaceView => ({
  status: 'pass',
  warnPct: 85,
  failPct: 95,
  checkedAt: '2026-10-16T08:00:00.000Z',
  filesystems: [
    { totalBytes: 100 * GB, usedBytes: 40 * GB, freeBytes: 60 * GB, usedPct: 40, status: 'pass', paths: [{ key: 'backups', label: 'Backups', path: '/backups' }, { key: 'cache', label: 'Cache', path: '/cache' }] },
  ],
  unmeasured: [{ key: 'database', label: 'Database', path: null, reason: 'Postgres runs on "postgres", so its disk cannot be measured from here' }],
  ...over,
});

describe('Free space on this server', () => {
  it('shows each disk with its folders, free space and how full it is', () => {
    const html = renderToStaticMarkup(<DiskSpace disk={disk()} />);
    expect(html).toContain('Free space');
    expect(html).toContain('Backups and cache');
    expect(html).toContain('60.0 GB free');
    expect(html).toContain('style="width:40%"');
    expect(html).toContain('<code');
    expect(html).toContain('/backups');
    expect(html).toContain('style="width:40%"');
    // a disk not measured from here: a value, its reason behind ?
    expect(html).toMatch(/Database<\/span>[\s\S]*Not measured/);
    expect(html).not.toContain('Bars show');
    // nothing to act on: no banner, no badge
    expect(html).not.toMatch(/tone-warning|tone-danger|Filling up|Almost full/);
  });

  it('marks a disk that is filling up or almost full, with a note that says what to do', () => {
    const warn = renderToStaticMarkup(<DiskSpace disk={disk({ status: 'warn', filesystems: [{ ...disk().filesystems[0]!, usedPct: 88, freeBytes: 12 * GB, status: 'warn' }] })} />);
    expect(warn).toContain('Filling up');
    expect(warn).toMatch(/tone-warning/);
    expect(warn).toContain('The disk is filling up.');
    expect(warn).toContain('Never delete Docker volumes.');
    const fail = renderToStaticMarkup(<DiskSpace disk={disk({ status: 'fail', filesystems: [{ ...disk().filesystems[0]!, usedPct: 97, freeBytes: 3 * GB, status: 'fail' }] })} />);
    expect(fail).toContain('Almost full');
    expect(fail).toMatch(/tone-danger/);
  });

  it('says so when the free space could not be read', () => {
    expect(renderToStaticMarkup(<DiskSpace disk={null} />)).toContain('Could not be read');
    expect(renderToStaticMarkup(<DiskSpace disk={undefined} />)).toContain('Could not be read');
  });
});

/** The text of every hint behind a `?` (HelpToggle's hidden region). */
const hidden = (html: string) => [...html.matchAll(/<div[^>]*hidden=""[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]).join('\n');

const OVERVIEW: StorageOverview = {
  checkedAt: '2026-10-16T08:00:00.000Z',
  database: { totalBytes: 2 * GB, categories: [{ key: 'library', label: 'Library', description: 'Albums, tracks and their tags', bytes: GB, tables: [{ name: 'tracks', bytes: GB }] }] },
  folders: [{ key: 'backups', label: 'Backups', path: '/backups', bytes: GB, files: 12, exists: true, truncated: false, error: null }],
  disk: disk(),
};
const cleanup = <TagChangeCleanupView scope="archived" onScope={() => undefined} preview={{ scope: 'archived', plans: 3, bytes: 1024, revertible: { plans: 0, bytes: 0 } }} onRun={() => undefined} />;

/** Manage backups is a link: render inside a router. */
async function withRouter(children: ReactNode): Promise<string> {
  const root = createRootRoute({ component: () => <>{children}</> });
  const router = createRouter({ routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: '/settings/$section' })]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe('Settings › Status › Storage on the settings layout', () => {
  it('the groups in order: Storage, Database, Folders, Free space, Tag change cleanup', async () => {
    const html = await withRouter(<StorageView data={OVERVIEW} onRefresh={() => undefined} cleanup={cleanup} />);
    const at = ['Storage', 'Database', 'Folders', 'Free space', 'Tag change cleanup'].map((t) => html.indexOf(`<section aria-label="${t}"`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).not.toMatch(/<h2|<h3 id=/);
  });

  it("a folder's description sits behind ?", async () => {
    const html = await withRouter(<StorageView data={OVERVIEW} onRefresh={() => undefined} cleanup={null} />);
    expect(hidden(html)).toContain('/backups');
    expect(hidden(html)).toContain('12 files');
    expect(html).not.toMatch(/<p class="[^"]*description/);
  });

  it('Tag change cleanup: the scope, the count, Delete as an action', () => {
    const html = renderToStaticMarkup(cleanup);
    expect(html).toMatch(/role="radiogroup" aria-label="Which plans"/);
    expect(html).toContain('3 plans');
    expect(html).toMatch(/>Delete</);
    expect(renderToStaticMarkup(<TagChangeCleanupView scope="archived" onScope={() => undefined} preview={{ scope: 'archived', plans: 0, bytes: 0, revertible: { plans: 0, bytes: 0 } }} onRun={() => undefined} />)).toContain('None');
    const failed = renderToStaticMarkup(<TagChangeCleanupView scope="archived" onScope={() => undefined} preview={null} failed onRun={() => undefined} />);
    expect(failed).toMatch(/role="alert"[^>]*>Could not count</);
  });
});
