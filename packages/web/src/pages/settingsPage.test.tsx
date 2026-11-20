/**
 * Settings is the server's (spec §3): only server sections, Status holds
 * System status and Storage, Library holds Deleting, Modules holds
 * Integrations, People and Tag writing renamed; a search over the static
 * index filters the section list. The owner's module pages keep only the
 * owner's parts; the person's part lives in Your settings.
 */
import { readFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { SectionNav } from '../components/settings/SectionNav';
import { SettingsSearch } from '../components/settings/SettingsSearch';
import { searchSettings } from './settingsIndex';
import { settingsNav } from './settingsSections';
import { settingsNavItems } from './settingsNavItems';

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const page = source('./SettingsPage.tsx');
/** The JSX of one `section === '<value>'` branch, up to the end of its line. */
const branch = (value: string) => {
  const at = page.indexOf(`{section === '${value}' &&`);
  if (at < 0) throw new Error(`no ${value} branch`);
  return page.slice(at, page.indexOf('\n', at));
};
const hasBranch = (value: string) => page.includes(`section === '${value}'`) || page.includes(`case '${value}'`);

async function withRouter(children: ReactNode): Promise<string> {
  const root = createRootRoute({ component: () => <>{children}</> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const nav = (query: string) => withRouter(
  <SectionNav
    label="Settings sections"
    items={settingsNavItems(searchSettings(query, settingsNav('owner')), false)}
    current={null}
    search={<SettingsSearch value={query} onChange={() => undefined} />}
    empty="No match"
  />,
);

describe('Settings is the server’s', () => {
  it('Settings lists only server sections', () => {
    expect(page).toMatch(/import \{[^}]*\bsettingsNav\b[^}]*\} from '\.\/settingsSections'/);
    expect(page).not.toMatch(/export function settingsNav/);
    for (const personal of ['account', 'appearance', 'security']) expect(hasBranch(personal)).toBe(false);
    expect(page).not.toContain('CUSTOM_THEME_SECTION');
    expect(page).not.toContain('YouAppearance');
  });

  it('Status holds System status and Storage', () => {
    expect(branch('status')).toContain('<SystemStatus />');
    expect(branch('status')).toContain('<SettingsStorageContent />');
    expect(hasBranch('system')).toBe(false);
    expect(hasBranch('storage')).toBe(false);
  });

  it('Library holds Deleting', () => {
    expect(branch('library')).toContain('<SettingsDeletingContent />');
    expect(hasBranch('deleting')).toBe(false);
  });

  it('Modules holds Integrations', () => {
    expect(branch('modules')).toContain('<SettingsProvidersPage />');
    expect(branch('modules')).toContain('id="integrations"');
    expect(hasBranch('providers')).toBe(false);
  });

  it('People and Tag writing are renamed', () => {
    expect(branch('people')).toContain('<SettingsUsersPage />');
    expect(branch('tag-writing')).toContain('<SettingsTagWritesContent />');
    expect(hasBranch('users')).toBe(false);
    expect(hasBranch('metadata')).toBe(false);
  });
});

describe('one heading style', () => {
  it("one h2 per section, the frame's", () => {
    // the section's name (or the module's on a module page), once, by the frame
    expect(page.match(/<h2>\{heading\}<\/h2>/g)).toHaveLength(1);
    expect(page).toMatch(/const heading = moduleName \?\? current/);
    for (const label of ['People', 'Modules', 'Backups', 'Status', 'Setup checklist']) expect(page).not.toContain(`<h2>${label}</h2>`);
    const pages = ['./SettingsScanRootsPage.tsx', '../components/naming/NamingSettings.tsx', '../components/naming/DropPoolSettings.tsx', './SettingsDeletingPage.tsx', './SettingsTagWritesPage.tsx', './SettingsFollowRulesPage.tsx', './SettingsGenresPage.tsx'];
    for (const file of pages) {
      const body = source(file);
      expect(body, file).not.toMatch(/<h2/);
      expect(body, file).not.toContain('sectionTitle');
    }
  });

  it('a module page and Updates render no heading of their own', () => {
    expect(source('./SettingsModulesPage.tsx')).not.toMatch(/<h2/);
    expect(source('./SettingsUpdatesPage.tsx')).not.toMatch(/<h2>Updates/);
  });
});

describe('Settings search', () => {
  it('the field names itself Search settings', async () => {
    const html = await nav('');
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Search settings"');
    expect(html).toContain('placeholder="Search settings"');
  });

  it('search filters the list', async () => {
    const html = await nav('drop');
    expect([...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1])).toEqual(['/settings/library']);
    expect(html).toContain('Drop pool');
  });

  it('search with no hit says so', async () => {
    const html = await nav('zzz');
    expect(html).toContain('No match');
    expect(html).not.toContain('<a');
  });

  it('a blank query lists every section with no second line, the update dot on Updates', () => {
    const items = settingsNavItems(searchSettings('', settingsNav('owner')), true);
    expect(items.map((i) => i.value)).toEqual(settingsNav('owner').map((s) => s.value));
    expect(items.every((i) => !i.detail)).toBe(true);
    expect(items.filter((i) => i.dot).map((i) => i.value)).toEqual(['updates']);
  });

  it('the page wires the search into the section list', () => {
    expect(page).toMatch(/searchSettings\(/);
    expect(page).toMatch(/<SettingsSearch /);
    expect(page).toMatch(/empty="No match"/);
  });
});

describe('the owner’s module pages keep only the owner’s parts', () => {
  const modules = source('./SettingsModulesPage.tsx');
  const content = modules.slice(modules.indexOf('export function SettingsModuleContent'));
  const playerCase = content.slice(content.indexOf("case 'player'"), content.indexOf("case 'lidarr'"));

  it('the owner’s Player page no longer holds Listening', () => {
    expect(playerCase).not.toContain('SettingsListeningContent');
    expect(playerCase).toContain('/you/listening');
    expect(playerCase).toContain('Your listening');
  });

  it('no module page holds a person\'s part', () => {
    expect(content).not.toMatch(/<SettingsDjContent|<DjSettings|<SettingsListenElsewhereContent|<SettingsConnectionsContent/);
  });

  it('the switch-only module pages are gone', () => {
    // their Off | On is in their Modules row; the address redirects (routing/redirects.ts)
    for (const slug of ['autotagger', 'playlists', 'similar-artists', 'dj', 'listen-links', 'mc']) expect(content).not.toContain(`case '${slug}'`);
  });
});

describe('Library care holds what moved', () => {
  it('Settings renders no Library care tab', () => {
    expect(page).not.toContain("'genre-mapping'");
    expect(page).not.toContain("'activity'");
    expect(page).not.toContain('JobsPage');
    expect(page).not.toContain('SettingsGenresContent');
  });

  it('a module row\'s address waits for the module\'s state', () => {
    expect(page).toMatch(/useFacets\(/);
    expect(page).toMatch(/redirectFor\(.*\bmodules \}\)/);
    expect(page).toMatch(/moduleRowOf\(/);
  });
});
