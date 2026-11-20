/**
 * Your settings (spec §2): the person's own settings at /you/<section>, the
 * same sticky shell and phone list-or-section layout as Settings. Account
 * holds Security; Maintenance lives in Library care's header (PR 3).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('Your settings', () => {
  it('Your settings is a sticky shell titled Your settings', () => {
    const tsx = source('./YouPage.tsx');
    expect(tsx).toMatch(/<PageShell title="Your settings" sticky>/);
    expect(tsx).toMatch(/usePhoneSubpage\(/);
    expect(tsx).toMatch(/data-view=\{view\}/);
    expect(tsx).toMatch(/<SectionNav\b/);
  });

  it('Account holds Security', () => {
    const tsx = source('./YouPage.tsx');
    const account = tsx.slice(tsx.indexOf("section === 'account'"));
    const branch = account.slice(0, account.indexOf('\n'));
    expect(branch).toMatch(/<SettingsAccountPage \/>/);
    expect(branch).toMatch(/<h2[^>]*>Security<\/h2><SettingsSecurityPage \/>/);
    expect(tsx).not.toMatch(/'security'/);
  });

  it('Appearance has no Maintenance', () => {
    const tsx = source('./YouAppearance.tsx');
    expect(tsx).not.toContain('Maintenance');
    expect(tsx).not.toContain('useMaintenance');
    expect(tsx).not.toContain('library.edit');
  });

  it('a module section that is off shows Off, not Not available', () => {
    const tsx = source('./YouPage.tsx');
    expect(tsx).toMatch(/>Off</);
    expect(tsx).not.toMatch(/NotAvailable/);
  });

  it('the routes render YouPage, its own lazy chunk', () => {
    const router = source('../router.tsx');
    expect(router).toMatch(/lazyRouteComponent\(\(\) => import\('\.\/pages\/YouPage'\), 'YouPage'\)/);
    expect(router).toMatch(/path: '\/you',\s*component: YouPage/);
    expect(router).toMatch(/path: '\/you\/\$section',\s*component: YouPage/);
  });

  it('Custom theme on a phone opens inside Your settings', () => {
    expect(source('../themes/ThemeSetting.tsx')).toMatch(/to: '\/you\/\$section', params: \{ section: CUSTOM_THEME_SECTION \}/);
  });
});
