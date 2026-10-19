/**
 * Settings › Storage errors say what failed. The page used to say "Only the
 * owner can see this page" for every error, also while the database was down.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROBLEM_TYPES, type DiskSpaceView } from '@tagave/shared';
import { DiskSpace, storageErrorText } from './SettingsStoragePage';

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
    expect(html).toContain('Database: not measured');
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
    expect(renderToStaticMarkup(<DiskSpace disk={null} />)).toContain('could not be read');
    expect(renderToStaticMarkup(<DiskSpace disk={undefined} />)).toContain('could not be read');
  });
});
