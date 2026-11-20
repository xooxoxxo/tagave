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
    expect(branch).toMatch(/<SettingsAccountPage \/><SettingsSecurityPage \/>/);
    expect(tsx).not.toMatch(/'security'/);
  });

  it("one h2 per section, the frame's", () => {
    const tsx = source('./YouPage.tsx');
    expect(tsx.match(/<h2/g)).toHaveLength(1);
    expect(tsx).toContain('<h2>{current.label}</h2>');
    for (const file of ['./YouAppearance.tsx', './SettingsAccountPage.tsx', './SettingsSecurityPage.tsx', '../themes/ThemeSetting.tsx']) {
      const body = source(file);
      expect(body, file).not.toMatch(/<h2/);
      expect(body, file).not.toContain('modeSetting');
    }
  });

  it('the phone hides the section heading with one rule', () => {
    const css = source('./SettingsPage.module.css');
    expect(css).toContain('.layout[data-view="section"] > .content > h2:first-child');
    expect(css).not.toMatch(/div:first-child > h2/);
  });

  it('Appearance has no Maintenance', () => {
    const tsx = source('./YouAppearance.tsx');
    expect(tsx).not.toContain('Maintenance');
    expect(tsx).not.toContain('useMaintenance');
    expect(tsx).not.toContain('library.edit');
  });

  it('no Off placeholder in Your settings', () => {
    // the modules rule: a section whose module is off goes to Account
    const tsx = source('./YouPage.tsx');
    expect(tsx).not.toContain('YouModuleOff');
    expect(tsx).not.toMatch(/>Off</);
    expect(tsx).not.toMatch(/NotAvailable/);
    expect(tsx).toMatch(/youGate\(/);
    expect(tsx).toMatch(/<Navigate\b[^>]*to="\/you\/\$section" params=\{\{ section: 'account' \}\}[^>]*\breplace\b[^>]*\/>/);
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
