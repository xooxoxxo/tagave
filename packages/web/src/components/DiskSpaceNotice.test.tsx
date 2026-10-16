/**
 * The disk-space notice: only the owner sees it, only while a disk warns or
 * fails, and never on Settings › Storage, which shows the same numbers.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiskSpaceView } from '@tagave/shared';
import { DiskSpaceNoticeView, diskFromChecks, diskNoticeText, diskStatusFromHealth, pathsLabel, showDiskNotice } from './DiskSpaceNotice';

const GB = 1024 ** 3;
const diskOf = (usedPct: number, status: DiskSpaceView['status']): DiskSpaceView => ({
  status,
  warnPct: 85,
  failPct: 95,
  checkedAt: '2026-10-16T08:00:00.000Z',
  filesystems: [{
    totalBytes: 100 * GB,
    usedBytes: usedPct * GB,
    freeBytes: (100 - usedPct) * GB,
    usedPct,
    status,
    paths: [{ key: 'backups', label: 'Backups', path: '/backups' }, { key: 'cache', label: 'Cache', path: '/cache' }],
  }],
  unmeasured: [],
});

const owner = { role: 'owner' as const };
const listener = { role: 'listener' as const };
const editor = { role: 'editor' as const };

describe('showDiskNotice', () => {
  it('shows the owner a disk that warns or fails', () => {
    expect(showDiskNotice(owner, diskOf(88, 'warn'), '/albums')).toBe(true);
    expect(showDiskNotice(owner, diskOf(97, 'fail'), '/')).toBe(true);
  });

  it('never shows anyone else, and nothing while the disk is fine', () => {
    expect(showDiskNotice(listener, diskOf(97, 'fail'), '/albums')).toBe(false);
    expect(showDiskNotice(editor, diskOf(97, 'fail'), '/albums')).toBe(false);
    expect(showDiskNotice(undefined, diskOf(97, 'fail'), '/albums')).toBe(false);
    expect(showDiskNotice(owner, diskOf(40, 'pass'), '/albums')).toBe(false);
    expect(showDiskNotice(owner, null, '/albums')).toBe(false);
  });

  it('stays off Settings › Storage, which says the same', () => {
    expect(showDiskNotice(owner, diskOf(97, 'fail'), '/settings/storage')).toBe(false);
    expect(showDiskNotice(owner, diskOf(97, 'fail'), '/settings/backups')).toBe(true);
  });
});

describe('diskNoticeText', () => {
  it('names the fullest disk, its folders and the free space', () => {
    expect(diskNoticeText(diskOf(88.4, 'warn'))).toEqual({ tone: 'warning', text: 'The disk is filling up. Backups and cache: 88% used, 11.6 GB free. Free space before the next update.' });
    expect(diskNoticeText(diskOf(97, 'fail'))?.tone).toBe('danger');
    expect(diskNoticeText(diskOf(97, 'fail'))?.text).toMatch(/^The disk is almost full\. Backups and cache: 97% used, 3\.0 GB free\./);
  });

  it('says when nothing could be measured', () => {
    expect(diskNoticeText({ ...diskOf(0, 'warn'), filesystems: [] })?.text).toMatch(/could not be read/);
  });
});

describe('pathsLabel', () => {
  it('joins labels in a sentence', () => {
    expect(pathsLabel(['Backups'])).toBe('Backups');
    expect(pathsLabel(['Backups', 'Cache'])).toBe('Backups and cache');
    expect(pathsLabel(['Backups', 'Cache', 'Database'])).toBe('Backups, cache and database');
  });
});

describe('reading the disk', () => {
  it('takes only the status from the public /health, also a 503 one', () => {
    expect(diskStatusFromHealth({ status: 'ok', disk: 'warn', checks: [] })).toBe('warn');
    expect(diskStatusFromHealth({ status: 'error', disk: 'error' })).toBe('error');
    expect(diskStatusFromHealth({ status: 'ok' })).toBeNull();
    expect(diskStatusFromHealth(new TypeError('Failed to fetch'))).toBeNull();
    expect(diskStatusFromHealth(null)).toBeNull();
  });

  it('takes the numbers from the owner’s /system/checks', () => {
    const disk = diskOf(88, 'warn');
    expect(diskFromChecks({ ok: true, checks: [{ id: 'database', status: 'pass' }, { id: 'disk', status: 'warn', disk }] })).toEqual(disk);
    expect(diskFromChecks({ checks: [{ id: 'database' }] })).toBeNull();
    expect(diskFromChecks(null)).toBeNull();
  });

  it('still says how the disk is when the numbers could not be fetched', () => {
    expect(diskNoticeText(null, 'warn')?.tone).toBe('warning');
    expect(diskNoticeText(null, 'error')).toMatchObject({ tone: 'danger', text: expect.stringMatching(/almost full/) });
    expect(diskNoticeText(null, 'ok')).toBeNull();
    expect(showDiskNotice(owner, null, '/albums', 'error')).toBe(true);
    expect(showDiskNotice(listener, null, '/albums', 'error')).toBe(false);
  });
});

describe('DiskSpaceNoticeView', () => {
  it('is a Banner in the warning or danger tone with the link it is given', () => {
    const warn = renderToStaticMarkup(<DiskSpaceNoticeView disk={diskOf(88, 'warn')} action={<a href="/settings/storage">Open Settings › Storage</a>} />);
    expect(warn).toContain('role="status"');
    expect(warn).toMatch(/tone-warning/);
    expect(warn).toContain('The disk is filling up.');
    expect(warn).toContain('href="/settings/storage"');
    expect(renderToStaticMarkup(<DiskSpaceNoticeView disk={diskOf(97, 'fail')} action={null} />)).toMatch(/tone-danger/);
    expect(renderToStaticMarkup(<DiskSpaceNoticeView disk={diskOf(40, 'pass')} action={null} />)).toBe('');
  });
});
