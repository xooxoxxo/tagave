import { describe, expect, it } from 'vitest';
import type { BackupEntry, BackupKind } from './backup.js';
import { inferBackupVersions, type UpdateHistoryRow } from './backupVersions.js';

const entry = (name: string, kind: BackupKind, createdAt: string, recorded: Partial<Pick<BackupEntry, 'version' | 'toVersion'>> = {}): BackupEntry => ({
  name, kind, createdAt, bytes: 1, verified: true, version: recorded.version ?? null, versionInferred: false, toVersion: recorded.toVersion ?? null,
});

// 0.9.0 → 0.10.0 on 2 Oct (the app's own dump), 0.10.0 → 0.11.0 on 16 Oct
const history: UpdateHistoryRow[] = [
  { createdAt: new Date('2026-10-16T16:41:00Z'), path: '/backups/tagave-2026-10-16T16-41-00Z-pre-migration.pgdump', fromVersion: '0.10.0', toVersion: '0.11.0' },
  { createdAt: new Date('2026-10-02T07:10:00Z'), path: '/backups/tagave-2026-10-02T07-10-00Z-pre-migration.pgdump', fromVersion: '0.9.0', toVersion: '0.10.0' },
];

const one = (e: BackupEntry, rows = history) => inferBackupVersions([e], rows)[0];

describe('inferBackupVersions', () => {
  it('keeps a version recorded with the dump', () => {
    expect(one(entry('a.pgdump', 'nightly', '2026-09-01T01:00:00.000Z', { version: '0.12.0' }))).toMatchObject({ version: '0.12.0', versionInferred: false, toVersion: null });
  });

  it('takes a before-update dump named in the history as exact', () => {
    expect(one(entry('tagave-2026-10-02T07-10-00Z-pre-migration.pgdump', 'pre-migration', '2026-10-02T07:10:00.000Z')))
      .toMatchObject({ version: '0.9.0', versionInferred: false, toVersion: '0.10.0' });
  });

  it("matches the updater's dump to the row the app wrote right after it", () => {
    expect(one(entry('tagave-2026-10-16T16-30-00Z-pre-migration.pgdump', 'pre-migration', '2026-10-16T16:30:00.000Z')))
      .toMatchObject({ version: '0.10.0', versionInferred: true, toVersion: '0.11.0' });
  });

  it('adds the target to a recorded before-update dump that lacks it', () => {
    expect(one(entry('tagave-2026-10-16T16-41-00Z-pre-migration.pgdump', 'pre-migration', '2026-10-16T16:41:00.000Z', { version: '0.10.0' })))
      .toMatchObject({ version: '0.10.0', versionInferred: false, toVersion: '0.11.0' });
  });

  it('places other dumps on the timeline, marked inferred', () => {
    expect(one(entry('n1', 'nightly', '2026-10-12T01:00:00.000Z'))).toMatchObject({ version: '0.10.0', versionInferred: true });
    expect(one(entry('n2', 'nightly', '2026-10-20T01:00:00.000Z'))).toMatchObject({ version: '0.11.0', versionInferred: true });
    // before the first update: the version that update came from
    expect(one(entry('n3', 'nightly', '2026-09-28T01:00:00.000Z'))).toMatchObject({ version: '0.9.0', versionInferred: true });
  });

  it('says unknown when there is no history', () => {
    expect(one(entry('m', 'manual', '2026-09-14T17:30:00.000Z'), [])).toMatchObject({ version: null, versionInferred: false });
  });

  it('says unknown before a first update whose source version was not recorded', () => {
    const rows = [{ createdAt: '2026-10-02T07:10:00Z', path: null, fromVersion: null, toVersion: '0.10.0' }];
    expect(one(entry('m', 'manual', '2026-09-14T17:30:00.000Z'), rows)).toMatchObject({ version: null });
    expect(one(entry('m', 'manual', '2026-10-14T17:30:00.000Z'), rows)).toMatchObject({ version: '0.10.0', versionInferred: true });
  });
});
