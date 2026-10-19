import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mainPageOf, pageTitle, pageTitles } from './pageTitles';
import { parentLabel } from './backNav';

describe('page titles (phone top bar)', () => {
  it('names every main page', () => {
    expect(pageTitle('/')).toBe('Home');
    expect(pageTitle('/albums')).toBe('Albums');
    expect(pageTitle('/artists')).toBe('Artists');
    expect(pageTitle('/collection')).toBe('Physical collection');
    expect(pageTitle('/work')).toBe('Library care');
    expect(pageTitle('/plans')).toBe('Tag changes');
    expect(pageTitle('/settings')).toBe('Settings');
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
    const layout = readFileSync(new URL('../components/Layout.tsx', import.meta.url), 'utf8');
    for (const label of Object.values(pageTitles)) {
      expect(layout).not.toMatch(new RegExp(`>${label}[<{]`));
    }
    for (const page of Object.keys(pageTitles)) expect(layout).toContain(`pageTitles['${page}']`);
    expect(parentLabel('/plans')).toBe('Tag changes');
    expect(parentLabel('/albums')).toBe('Albums');
  });
});
