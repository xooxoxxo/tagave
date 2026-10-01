// Pure rules from @liner/db's migrations-lib (that package has no test runner).
import { describe, it, expect } from 'vitest';
import { classifySkew, compareVersions, type SchemaState } from '@liner/db';

const base: SchemaState = {
  files: ['0001_a.sql', '0002_b.sql'],
  applied: ['0001_a.sql', '0002_b.sql'],
  pending: [],
  unknown: [],
  newer: [],
  schemaAppVersion: '0.4.1',
  fresh: false,
};

describe('compareVersions', () => {
  it('orders releases and pre-releases', () => {
    expect(compareVersions('0.5.0', '0.4.1')).toBe(1);
    expect(compareVersions('0.4.1', '0.4.1')).toBe(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });
  it('treats unknown versions as unknown, not as old', () => {
    expect(compareVersions('0.0.0', '0.4.1')).toBeNull();
    expect(compareVersions(null, '0.4.1')).toBeNull();
    expect(compareVersions('dev', '0.4.1')).toBeNull();
  });
});

describe('classifySkew', () => {
  it('ok when the ledger matches', () => {
    expect(classifySkew(base, '0.4.1').verdict).toBe('ok');
  });
  it('pending when this build carries a file the database lacks', () => {
    expect(classifySkew({ ...base, pending: ['0003_c.sql'] }, '0.4.1').verdict).toBe('pending');
  });
  it('newer when a newer app stamped the database', () => {
    const v = classifySkew({ ...base, schemaAppVersion: '0.5.0' }, '0.4.1');
    expect(v.verdict).toBe('newer');
    expect(v.detail).toMatch(/0\.5\.0, newer than this build \(0\.4\.1\)/);
  });
  it('newer when the ledger has files past this build, even with the same version', () => {
    expect(classifySkew({ ...base, unknown: ['0003_c.sql'], newer: ['0003_c.sql'] }, '0.4.1').verdict).toBe('newer');
  });
  it('a renumbered file before the last one is not a skew', () => {
    expect(classifySkew({ ...base, unknown: ['0001_old.sql'], newer: [] }, '0.4.1').verdict).toBe('ok');
  });
  it('newer wins over pending', () => {
    expect(classifySkew({ ...base, pending: ['0003_c.sql'], schemaAppVersion: '1.0.0' }, '0.4.1').verdict).toBe('newer');
  });
});
