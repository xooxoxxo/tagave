/**
 * Confirms on destructive actions (DESIGN.md): an action asks first when it
 * loses something one click cannot get back or stops work in progress. Each
 * of these asks, in the danger tone, its title the question; a price's
 * Remove does not (adding it again is one click).
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirmDialog = vi.fn((_: unknown) => Promise.resolve(true));
vi.mock('./ConfirmDialog', () => ({ confirmDialog: (o: unknown) => confirmDialog(o) }));
const { ASK_FIRST, askFirst } = await import('./askFirst');

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Where each action's handler lives. */
const WHERE: Record<keyof typeof ASK_FIRST, string[]> = {
  forgetDiscogsToken: ['../../pages/SettingsProvidersPage.tsx'],
  forgetAcoustidKey: ['../../pages/SettingsProvidersPage.tsx'],
  forgetJevKey: ['../../pages/review/AutotaggerPanel.tsx'],
  forgetClientSecret: ['../users/SignInService.tsx'],
  cancelRun: ['../../pages/review/AutotaggerPanel.tsx'],
  revokeLink: ['../../pages/SettingsUsersPage.tsx'],
  useSharedLogin: ['../../pages/SettingsListeningPage.tsx'],
};

describe('askFirst', () => {
  beforeEach(() => confirmDialog.mockClear());

  it('every confirm is a question in the danger tone', async () => {
    for (const key of Object.keys(ASK_FIRST) as Array<keyof typeof ASK_FIRST>) {
      expect(ASK_FIRST[key].title, key).toMatch(/^[A-Z][^?]*\?$/);
      expect(ASK_FIRST[key].confirmLabel, key).toBeTruthy();
      await askFirst(key);
      expect(confirmDialog).toHaveBeenLastCalledWith(expect.objectContaining({ title: ASK_FIRST[key].title, tone: 'danger' }));
    }
  });

  it('each destructive action asks it first', () => {
    for (const [key, files] of Object.entries(WHERE)) {
      for (const file of files) expect(source(file), `${key} in ${file}`).toContain(`askFirst('${key}')`);
    }
  });

  it('the Discogs token and AcoustID key ask on the setup checklist too', () => {
    const checklist = source('../../pages/SetupChecklistContent.tsx');
    expect(checklist).toMatch(/askForgetSecret\(key\)/);
    expect(source('../../pages/SettingsProvidersPage.tsx')).toMatch(/askForgetSecret\(key\)/);
  });

  it('a price Remove does not ask', () => {
    expect(Object.keys(ASK_FIRST).some((k) => /price/i.test(k))).toBe(false);
  });
});
