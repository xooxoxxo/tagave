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

describe('the Settings nav with modules off', () => {
  it('a listener does not see Connections while Music Connections is off (QA Q-42)', () => {
    expect(settingsNav('listener', { mcOn: false }).map((s) => s.value)).not.toContain('connections');
    expect(settingsNav('listener', { mcOn: true }).map((s) => s.value)).toContain('connections');
    // the owner keeps it: it says where to turn the module on
    expect(settingsNav('owner', { mcOn: false }).map((s) => s.value)).toContain('connections');
  });

  it('lists Listen elsewhere only while its module is on', () => {
    expect(settingsNav('listener', { listenOn: false }).map((s) => s.value)).not.toContain('listen-elsewhere');
    expect(settingsNav('listener', { listenOn: true }).map((s) => s.value)).toContain('listen-elsewhere');
  });
});
