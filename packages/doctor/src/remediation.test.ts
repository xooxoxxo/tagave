import { describe, expect, it } from 'vitest';
import { remediationFor } from './remediation.js';

const ids = ['database', 'migrations', 'contactString', 'workerHeartbeat', 'versions', 'scanRoots', 'cacheDir', 'providers', 'appSecret'];

describe('remediationFor', () => {
  it('says nothing for a passing or skipped check', () => {
    for (const id of ids) {
      expect(remediationFor({ id, status: 'pass', detail: '' })).toBeNull();
      expect(remediationFor({ id, status: 'skip', detail: '' })).toBeNull();
    }
  });

  it('gives a fix for every check the doctor runs when it fails or warns', () => {
    for (const id of ids) {
      for (const status of ['fail', 'warn'] as const) {
        const text = remediationFor({ id, status, detail: '' });
        expect(text, `${id}/${status}`).toBeTruthy();
        expect(text).not.toContain('undefined');
      }
    }
  });

  it('tells a split install that folders are checked on the worker host', () => {
    expect(remediationFor({ id: 'scanRoots', status: 'fail', detail: '' })).toMatch(/worker host/);
  });

  it('distinguishes a missing worker from a short one', () => {
    expect(remediationFor({ id: 'workerHeartbeat', status: 'fail', detail: '' })).toMatch(/No worker/);
    expect(remediationFor({ id: 'workerHeartbeat', status: 'warn', detail: '' })).toMatch(/none of them takes/);
  });

  it('gives the installer command before the source-checkout one for a missing worker', () => {
    const text = remediationFor({ id: 'workerHeartbeat', status: 'fail', detail: '' }) ?? '';
    expect(text).toContain('~/tagave');
    expect(text.indexOf('`docker compose up -d`')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('`docker compose up -d`')).toBeLessThan(text.indexOf('docker-compose.prod.yml'));
  });

  it('returns null for a check it does not know', () => {
    expect(remediationFor({ id: 'nope', status: 'fail', detail: '' })).toBeNull();
  });
});
