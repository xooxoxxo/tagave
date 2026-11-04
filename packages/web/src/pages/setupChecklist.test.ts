/**
 * The setup checklist is first-run only: Home shows it to the owner while a
 * required step is open and it was not dismissed; Settings no longer lists it.
 */
import { describe, expect, it } from 'vitest';
import { setupComplete, showSetupChecklist } from './setupChecklist';
import { settingsNav } from './SettingsPage';

const done = { contactString: 'me@example.com', onboardingCompletedAt: '2026-10-01T10:00:00.000Z', setupChecklistDismissedAt: null };
const ok = [{ validationStatus: 'ok' as const }];

describe('the setup checklist on Home', () => {
  it('shows while a required step is open', () => {
    expect(showSetupChecklist(true, { ...done, contactString: null }, ok)).toBe(true);
    expect(showSetupChecklist(true, done, [])).toBe(true);
    expect(showSetupChecklist(true, done, [{ validationStatus: 'missing' }])).toBe(true);
    expect(showSetupChecklist(true, { ...done, onboardingCompletedAt: null }, ok)).toBe(true);
  });

  it('goes once every required step is done', () => {
    expect(setupComplete(done, ok)).toBe(true);
    expect(showSetupChecklist(true, done, ok)).toBe(false);
  });

  it('goes for good once dismissed', () => {
    expect(showSetupChecklist(true, { ...done, contactString: null, setupChecklistDismissedAt: '2026-10-20T10:00:00.000Z' }, [])).toBe(false);
  });

  it('is the owner’s only, and waits for the settings and folders', () => {
    expect(showSetupChecklist(false, { ...done, contactString: null }, [])).toBe(false);
    expect(showSetupChecklist(true, undefined, [])).toBe(false);
    expect(showSetupChecklist(true, done, undefined)).toBe(false);
  });
});

describe('the Settings nav', () => {
  it('no longer lists the setup checklist', () => {
    const owner = settingsNav('owner').map((s) => s.value);
    expect(owner).not.toContain('setup-checklist');
    expect(owner).toContain('updates');
  });
});

describe('the Settings nav and the modules', () => {
  it('lists no section of a module: each lives in Settings › Modules', () => {
    for (const role of ['owner', 'editor', 'listener'] as const) {
      const nav = settingsNav(role, { rows: 3 }).map((s) => s.value);
      for (const moved of ['connections', 'listen-elsewhere', 'playback', 'listening']) expect(nav).not.toContain(moved);
    }
  });

  it('a listener sees Modules only while a module has something of theirs (QA Q-42)', () => {
    expect(settingsNav('listener', { rows: 0 }).map((s) => s.value)).not.toContain('modules');
    expect(settingsNav('listener', { rows: null }).map((s) => s.value)).not.toContain('modules');
    expect(settingsNav('listener', { rows: 1 }).map((s) => s.value)).toContain('modules');
    // the owner always: every module's Off | On is there
    expect(settingsNav('owner', { rows: 0 }).map((s) => s.value)).toContain('modules');
  });

  it('a listener finds Modules with their account; the owner under System', () => {
    expect(settingsNav('listener', { rows: 1 }).at(-1)).toMatchObject({ value: 'modules', group: 'Account' });
    expect(settingsNav('owner').find((s) => s.value === 'modules')?.group).toBe('System');
  });
});
