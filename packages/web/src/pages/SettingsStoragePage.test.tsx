/**
 * Settings › Storage errors say what failed. The page used to say "Only the
 * owner can see this page" for every error, also while the database was down.
 */
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@tagave/shared';
import { storageErrorText } from './SettingsStoragePage';

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
