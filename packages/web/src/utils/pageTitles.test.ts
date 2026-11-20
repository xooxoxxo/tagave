import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mainPageOf, pageTitle, pageTitles } from './pageTitles';
import { parentLabel } from './backNav';
import { identityMenu, sidebarNav } from '../components/navModel';

describe('page titles (phone top bar)', () => {
  it('names every main page', () => {
    expect(pageTitle('/')).toBe('Home');
    expect(pageTitle('/albums')).toBe('Albums');
    expect(pageTitle('/artists')).toBe('Artists');
    expect(pageTitle('/collection')).toBe('Physical collection');
    expect(pageTitle('/work')).toBe('Library care');
    expect(pageTitle('/plans')).toBe('Tag changes');
    expect(pageTitle('/settings')).toBe('Settings');
    expect(pageTitle('/you')).toBe('Your settings');
    expect(pageTitle('/you/account')).toBe('Your settings');
  });

  it('a page under a main page carries its name; older paths their new page', () => {
    expect(pageTitle('/albums/42')).toBe('Albums');
    expect(pageTitle('/settings/backups')).toBe('Settings');
    expect(pageTitle('/settings/')).toBe('Settings');
    expect(pageTitle('/queue')).toBe('Library care');
    expect(pageTitle('/attention')).toBe('Library care');
    expect(pageTitle('/jobs')).toBe('Settings');
    expect(mainPageOf('/identify')).toBe('/work');
  });

  it('pages outside the app frame have none', () => {
    for (const p of ['/login', '/setup', '/onboarding', '/invite/abc', '/albumsx']) expect(pageTitle(p)).toBeNull();
  });

  it('is the one source of the sidebar labels and the back button names', () => {
    // Layout renders what navModel lists (the sidebar) and IdentityRow the person menu
    const layout = ['../components/Layout.tsx', '../components/navModel.ts', '../components/IdentityRow.tsx']
      .map((rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')).join('\n');
    for (const label of Object.values(pageTitles)) {
      expect(layout).not.toMatch(new RegExp(`>${label}[<{]`));
    }
    // every main page is listed by its title: the sidebar's two groups and the person menu
    const { browse, care } = sidebarNav({ pathname: '/', canCare: true, taskCount: 0, modules: { playlists: true, likes: true, books: true } });
    const listed = new Map([...browse, ...care].map((i) => [i.to, i.label]));
    for (const i of identityMenu({ hasSettings: true })) if (i.to) listed.set(i.to, i.label);
    expect(Object.fromEntries(listed)).toEqual(pageTitles);
    expect(parentLabel('/plans')).toBe('Tag changes');
    expect(parentLabel('/albums')).toBe('Albums');
  });
});
