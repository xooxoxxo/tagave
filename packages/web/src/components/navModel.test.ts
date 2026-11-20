/**
 * What the sidebar and the person menu list for a role: Browse for everyone,
 * Care (Library care, Tag changes) for those who look after the library, and
 * the menu's Your settings, Settings, Sign out.
 */
import { describe, expect, it } from 'vitest';
import { accountInitial } from './accountInitial';
import { identityDot, identityMenu, sidebarNav } from './navModel';
import { settingsNav } from '../pages/settingsSections';

const allModules = { playlists: true, likes: true, books: true };
const nav = (o: Partial<Parameters<typeof sidebarNav>[0]> = {}) =>
  sidebarNav({ pathname: '/', canCare: true, taskCount: 0, modules: allModules, ...o });

describe('sidebarNav', () => {
  it('listener gets browse only', () => {
    const { browse, care } = nav({ canCare: false });
    expect(care).toEqual([]);
    expect(browse.map((i) => i.key)).toEqual(['home', 'albums', 'artists', 'collection', 'playlists', 'liked', 'books']);
    expect(identityMenu({ hasSettings: false }).map((i) => i.key)).toEqual(['you', 'signout']);
  });

  it('editor gets Care in order', () => {
    const { care } = nav({ taskCount: 3 });
    expect(care.map((i) => i.label)).toEqual(['Library care', 'Tag changes']);
    expect(care[0]?.count).toBe(3);
    expect(care[0]?.countLabel).toBe('open tasks');
    expect(care[0]?.to).toBe('/work');
    expect(care[0]?.search).toEqual({ tab: 'review' });
    expect(care[1]?.to).toBe('/plans');
    expect(nav({ taskCount: 1 }).care[0]?.countLabel).toBe('open task');
  });

  it('Library care is current on /identify', () => {
    const { care } = nav({ pathname: '/identify/abc' });
    expect(care[0]?.current).toBe(true);
    expect(care[1]?.current).toBe(false);
    for (const p of ['/work', '/queue', '/attention']) expect(nav({ pathname: p }).care[0]?.current).toBe(true);
    expect(nav({ pathname: '/plans' }).care[1]?.current).toBe(true);
  });

  it('browse respects modules', () => {
    const { browse } = nav({ modules: { playlists: false, likes: true, books: true } });
    expect(browse.map((i) => i.key)).toEqual(['home', 'albums', 'artists', 'collection', 'liked', 'books']);
    expect(nav({ modules: { playlists: false, likes: false, books: false } }).browse.map((i) => i.key)).toEqual(['home', 'albums', 'artists', 'collection']);
  });

  it('browse labels come from the page titles and mark the current page', () => {
    const { browse } = nav({ pathname: '/albums/xyz' });
    expect(browse.map((i) => i.label)).toEqual(['Home', 'Albums', 'Artists', 'Physical collection', 'Playlists', 'Liked songs', 'Books']);
    expect(browse.filter((i) => i.current).map((i) => i.key)).toEqual(['albums']);
    expect(nav({ pathname: '/' }).browse.filter((i) => i.current).map((i) => i.key)).toEqual(['home']);
  });
});

describe('identityMenu', () => {
  it('menu order', () => {
    const menu = identityMenu({ hasSettings: settingsNav('editor').length > 0 });
    expect(menu.map((i) => i.key)).toEqual(['you', 'settings', 'signout']);
    expect(menu.map((i) => i.label)).toEqual(['Your settings', 'Settings', 'Sign out']);
    expect(menu.find((i) => i.key === 'you')?.to).toBe('/you');
    expect(menu.find((i) => i.key === 'settings')?.to).toBe('/settings');
    expect(menu.find((i) => i.key === 'signout')?.to).toBeUndefined();
  });

  it('an editor with a server section gets Settings', () => {
    expect(identityMenu({ hasSettings: settingsNav('editor').length > 0 }).map((i) => i.key)).toContain('settings');
    expect(identityMenu({ hasSettings: settingsNav('owner').length > 0 }).map((i) => i.key)).toContain('settings');
  });

  it('a listener gets no Settings', () => {
    const menu = identityMenu({ hasSettings: settingsNav('listener').length > 0 });
    expect(menu.map((i) => i.key)).toEqual(['you', 'signout']);
    expect(menu.find((i) => i.key === 'you')?.to).toBe('/you');
  });
});

describe('identityDot', () => {
  it("update dot is the owner's", () => {
    expect(identityDot({ owner: false, updateAvailable: true })).toBeNull();
    expect(identityDot({ owner: true, updateAvailable: false })).toBeNull();
    expect(identityDot({ owner: true, updateAvailable: true })).toBe('a new version is available');
  });
});

describe('accountInitial', () => {
  it('initial falls back to the email', () => {
    expect(accountInitial('', 'zed@example.com')).toBe('Z');
    expect(accountInitial('  ', 'kim@example.com')).toBe('K');
    expect(accountInitial('Émile', 'e@example.com')).toBe('É');
  });
});
