/**
 * TAGAVE_* environment variables and their pre-0.9 LINER_* names (read until
 * 0.10, with a one-time deprecation warning).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { legacyEnvName, readRenamedEnv, resetEnvWarnings, tagaveEnv } from '@tagave/shared/env';

describe('tagaveEnv', () => {
  let warnings: string[];
  const warn = (m: string) => warnings.push(m);
  beforeEach(() => {
    warnings = [];
    resetEnvWarnings();
  });

  it('reads the new name and never warns for it', () => {
    expect(tagaveEnv('QUEUES', { TAGAVE_QUEUES: 'scan.root' }, warn)).toBe('scan.root');
    expect(warnings).toEqual([]);
  });

  it('prefers the new name when both are set', () => {
    expect(tagaveEnv('QUEUES', { TAGAVE_QUEUES: 'a', LINER_QUEUES: 'b' }, warn)).toBe('a');
    expect(warnings).toEqual([]);
  });

  it('falls back to the old name, warning once per name and process', () => {
    expect(tagaveEnv('QUEUES', { LINER_QUEUES: 'b' }, warn)).toBe('b');
    expect(tagaveEnv('QUEUES', { LINER_QUEUES: 'b' }, warn)).toBe('b');
    expect(tagaveEnv('LIBRARY_ID', { LINER_LIBRARY_ID: 'x' }, warn)).toBe('x');
    expect(warnings).toEqual([
      'LINER_QUEUES is deprecated: rename it to TAGAVE_QUEUES. The old name stops working in tagave 0.10.',
      'LINER_LIBRARY_ID is deprecated: rename it to TAGAVE_LIBRARY_ID. The old name stops working in tagave 0.10.',
    ]);
  });

  it('treats an empty new name as unset, and keeps an empty value when nothing else is set', () => {
    expect(tagaveEnv('QUEUES', { TAGAVE_QUEUES: '', LINER_QUEUES: 'b' }, warn)).toBe('b');
    expect(tagaveEnv('QUEUES', { TAGAVE_QUEUES: '' }, warn)).toBe('');
    expect(tagaveEnv('QUEUES', {}, warn)).toBeUndefined();
  });

  it('maps the build version to its old name LINER_VERSION (TAGAVE_VERSION is the image tag)', () => {
    expect(legacyEnvName('BUILD_VERSION')).toBe('LINER_VERSION');
    expect(legacyEnvName('QUEUES')).toBe('LINER_QUEUES');
    expect(tagaveEnv('BUILD_VERSION', { LINER_VERSION: '0.8.0', TAGAVE_VERSION: 'latest' }, warn)).toBe('0.8.0');
  });

  it('readRenamedEnv takes any pair of names', () => {
    expect(readRenamedEnv('BACKUP_DIR', 'LINER_BACKUP_DIR', { LINER_BACKUP_DIR: '/b' }, warn)).toBe('/b');
    expect(warnings[0]).toMatch(/^LINER_BACKUP_DIR is deprecated: rename it to BACKUP_DIR\./);
  });
});
