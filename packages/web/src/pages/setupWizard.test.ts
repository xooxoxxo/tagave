import { describe, expect, it } from 'vitest';
import {
  SETUP_STEPS,
  folderAdvice,
  infrastructureChecks,
  normalizeAccount,
  setupBlocked,
  stepNumber,
  validateAccount,
  validateContact,
  workerLive,
  type AccountForm,
  type SystemCheck,
} from './setupWizard';

const good: AccountForm = { email: 'me@example.com', password: 'eight888', displayName: 'Me', contactString: 'me@example.com' };

describe('validateAccount', () => {
  it('accepts what the server accepts', () => {
    expect(validateAccount(good)).toEqual({});
    expect(validateAccount({ ...good, contactString: 'https://example.com' })).toEqual({});
  });

  it('uses the server password rule: 8 characters, not 12', () => {
    expect(validateAccount({ ...good, password: 'seven77' }).password).toBeTruthy();
    expect(validateAccount({ ...good, password: '12345678' }).password).toBeUndefined();
  });

  it('requires a contact the server takes: an email or a URL', () => {
    expect(validateAccount({ ...good, contactString: '' }).contactString).toBeTruthy();
    expect(validateAccount({ ...good, contactString: 'tagave/1.0' }).contactString).toBeTruthy();
    expect(validateAccount({ ...good, contactString: 'example.com' }).contactString).toBeTruthy();
  });

  it('flags every missing field with plain text', () => {
    const errors = validateAccount({ email: '', password: '', displayName: '  ', contactString: '' });
    expect(Object.keys(errors).sort()).toEqual(['contactString', 'displayName', 'email', 'password']);
    for (const message of Object.values(errors)) expect(message).not.toContain('undefined');
  });

  it('checks a contact on its own with the same rule', () => {
    expect(validateContact(' me@example.com ')).toBeUndefined();
    expect(validateContact('https://example.com')).toBeUndefined();
    expect(validateContact('tagave/1.0')).toBeTruthy();
  });

  it('trims everything except the password', () => {
    expect(normalizeAccount({ email: ' a@b.co ', password: ' pass word ', displayName: ' A ', contactString: ' a@b.co ' }))
      .toEqual({ email: 'a@b.co', password: ' pass word ', displayName: 'A', contactString: 'a@b.co' });
  });
});

describe('steps', () => {
  it('numbers steps by their position', () => {
    expect(SETUP_STEPS.map(stepNumber)).toEqual([1, 2, 3, 4]);
    expect(stepNumber('Music folder')).toBe(3);
  });
});

describe('system checks before the account exists', () => {
  const checks: SystemCheck[] = [
    { id: 'database', title: 'Database', status: 'pass' },
    { id: 'migrations', title: 'Migrations', status: 'pass' },
    { id: 'contactString', title: 'Contact String', status: 'fail' },
    { id: 'workerHeartbeat', title: 'Worker Heartbeat', status: 'fail' },
    { id: 'scanRoots', title: 'Scan Roots', status: 'warn' },
    { id: 'providers', title: 'Providers', status: 'skip' },
  ];

  it('leaves out the checks that later steps take care of', () => {
    expect(infrastructureChecks(checks).map((c) => c.id)).toEqual(['database', 'migrations', 'workerHeartbeat']);
  });

  it('blocks the account only on the database or its schema', () => {
    expect(setupBlocked(checks)).toBe(false);
    expect(setupBlocked([{ id: 'migrations', title: 'Migrations', status: 'fail' }])).toBe(true);
    expect(setupBlocked([{ id: 'database', title: 'Database', status: 'fail' }])).toBe(true);
  });

  it('reads worker liveness from the heartbeat check', () => {
    expect(workerLive(checks)).toBe(false);
    expect(workerLive([{ id: 'workerHeartbeat', title: '', status: 'warn' }])).toBe(true);
    expect(workerLive(undefined)).toBeUndefined();
  });
});

describe('folderAdvice', () => {
  const root = { path: '/music', validationMessage: null, probeWritable: null, writable: true, createdAt: '2026-09-28T10:00:00.000Z' };
  const now = Date.parse('2026-09-28T10:00:05.000Z');

  it('waits quietly while a live worker checks the folder', () => {
    expect(folderAdvice({ ...root, validationStatus: 'pending' }, { workerLive: true, now }).tone).toBe('info');
  });

  it('says no worker is running when a folder cannot be checked', () => {
    const advice = folderAdvice({ ...root, validationStatus: 'pending' }, { workerLive: false, now });
    expect(advice.tone).toBe('warning');
    expect(advice.text).toMatch(/Start the worker/);
  });

  it('explains a missing path in terms of the worker host, for split installs', () => {
    const advice = folderAdvice({ ...root, validationStatus: 'missing' }, { now });
    expect(advice.tone).toBe('danger');
    expect(advice.text).toContain('/music');
    expect(advice.text).toMatch(/worker host/);
    expect(advice.text).toMatch(/NFS/);
    expect(advice.text).toMatch(/SMB/);
    expect(advice.text).not.toMatch(/mkdir/);
  });

  it('gives a permission fix for an unreadable folder, not a mkdir', () => {
    const advice = folderAdvice({ ...root, validationStatus: 'unreadable' }, { now });
    expect(advice.text).toMatch(/read access/);
    expect(advice.text).not.toMatch(/mkdir/);
  });

  it('marks a read-only mount as usable, with a note', () => {
    expect(folderAdvice({ ...root, validationStatus: 'ok', probeWritable: false }, { now }).tone).toBe('warning');
    expect(folderAdvice({ ...root, validationStatus: 'ok', probeWritable: true }, { now }).tone).toBe('success');
    expect(folderAdvice({ ...root, validationStatus: 'ok', probeWritable: false, writable: false }, { now }).tone).toBe('success');
  });

  it('never renders undefined', () => {
    for (const status of ['pending', 'ok', 'missing', 'not_directory', 'unreadable'] as const) {
      const advice = folderAdvice({ ...root, validationStatus: status }, { now });
      expect(`${advice.title} ${advice.text}`).not.toContain('undefined');
    }
  });
});
