import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { moduleRowOf, moduleStates, redirectFor, type Redirect, type Who } from './redirects';
import { MOVED_SECTIONS } from '../pages/moduleSettings';
import { YOU_SECTIONS } from '../pages/youSections';
import { SERVER_SECTIONS } from '../pages/settingsSections';
import { WORK_TABS } from '../pages/workTabs';

/*
 * Every moved address redirects to its new home (spec §8), carrying its
 * query, in one hop. Without `who` only the rows that hold for anyone
 * apply; the page adds the role rows once the role is known, and the
 * module rows once the module's state is (the modules rule).
 */
const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const OWNER: Who = { owner: true, hasSettings: true, editor: true };
const EDITOR: Who = { owner: false, hasSettings: true, editor: true };
const LISTENER: Who = { owner: false, hasSettings: false, editor: false };
const Q = { job: 'j1', note: 'kept' };
const ON = { autotagger: true, dj: true, 'listen-links': true, mc: true };
const OFF = { autotagger: false, dj: false, 'listen-links': false, mc: false };
const withModules = (who: Who, modules: Who['modules']): Who => ({ ...who, ...(modules && { modules }) });

/** Every target a test saw, checked against the real sections at the end. */
const seen: Redirect[] = [];
/** The redirect, its search the incoming one unless `expected` says otherwise. */
function go(pathname: string, search: Record<string, unknown> = Q, who?: Who, expected: Record<string, unknown> = search): Redirect {
  const r = redirectFor(pathname, search, who);
  expect(r, pathname).not.toBeNull();
  seen.push(r!);
  expect(r!.search).toEqual(expected);
  return r!;
}

describe('redirectFor', () => {
  it('/settings/account goes to /you/account', () => {
    expect(go('/settings/account').to).toBe('/you/account');
  });

  it('/settings/security goes to /you/account', () => {
    expect(go('/settings/security').to).toBe('/you/account');
  });

  it('/settings/appearance goes to /you/appearance', () => {
    expect(go('/settings/appearance').to).toBe('/you/appearance');
  });

  it('/settings/custom-theme goes to /you/custom-theme', () => {
    expect(go('/settings/custom-theme').to).toBe('/you/custom-theme');
  });

  it('each MOVED_SECTIONS entry goes straight to /you', () => {
    const keys = Object.keys(MOVED_SECTIONS);
    expect(keys.sort()).toEqual(['connections', 'listen-elsewhere', 'listening', 'playback']);
    for (const key of keys) {
      const r = go(`/settings/${key}`, {});
      expect(r.to).toMatch(/^\/you\//);
      expect(r.to).toBe(MOVED_SECTIONS[key]);
      expect(redirectFor(r.to, {})).toBeNull();
      expect(redirectFor(r.to, {}, LISTENER)).toBeNull();
    }
    expect(go('/settings/playback', {}).to).toBe('/you/listening');
    expect(go('/settings/listening', {}).to).toBe('/you/listening');
    expect(go('/settings/connections', {}).to).toBe('/you/connections');
    expect(go('/settings/listen-elsewhere', {}).to).toBe('/you/listen-elsewhere');
  });

  it('/settings/connections keeps ?linked= and ?error=', () => {
    expect(go('/settings/connections', { linked: 'l1' }).to).toBe('/you/connections');
    expect(go('/settings/connections', { error: 'access_denied' }).to).toBe('/you/connections');
  });

  it('/settings/listening keeps ?lastfm= and ?queued=', () => {
    expect(go('/settings/listening', { lastfm: 'ok', queued: '12' }).to).toBe('/you/listening');
  });

  it('a Music Connections return goes to Your settings for the owner too', () => {
    expect(go('/settings/modules/music-connections', { linked: 'l1' }).to).toBe('/you/connections');
    expect(go('/settings/modules/music-connections', { error: 'access_denied' }).to).toBe('/you/connections');
    expect(go('/settings/modules/music-connections', { linked: 'l1' }, OWNER).to).toBe('/you/connections');
  });

  it('a Last.fm return goes to Your settings', () => {
    expect(go('/settings/modules/player', { lastfm: 'ok' }).to).toBe('/you/listening');
    expect(go('/settings/modules/player', { lastfm: 'connected', queued: '3' }, OWNER).to).toBe('/you/listening');
  });

  it('the owner keeps the Player, Lidarr and Books pages', () => {
    for (const modules of [undefined, ON, OFF]) {
      const who = withModules(OWNER, modules);
      expect(redirectFor('/settings/modules/player', {}, who)).toBeNull();
      expect(redirectFor('/settings/modules/lidarr', {}, who)).toBeNull();
      expect(redirectFor('/settings/modules/books', {}, who)).toBeNull();
      expect(redirectFor('/settings/modules', {}, who)).toBeNull();
    }
    expect(redirectFor('/settings/modules/player', {})).toBeNull();
  });

  it("a listener's Player page goes to Your settings", () => {
    for (const who of [LISTENER, EDITOR]) expect(go('/settings/modules/player', Q, who).to).toBe('/you/listening');
    // the role rows wait for the role
    expect(redirectFor('/settings/modules/player', {})).toBeNull();
  });

  it('the Autotagger\'s settings page goes to its tab while on', () => {
    for (const who of [OWNER, EDITOR]) {
      expect(redirectFor('/settings/modules/autotagger', {}, withModules(who, { autotagger: true }))).toEqual({ to: '/work', search: { tab: 'autotagger' } });
      expect(go('/settings/modules/autotagger', Q, withModules(who, ON), { ...Q, tab: 'autotagger' }).to).toBe('/work');
    }
  });

  it('the Autotagger\'s settings page with the module off: Modules for the owner', () => {
    expect(go('/settings/modules/autotagger', Q, withModules(OWNER, { autotagger: false })).to).toBe('/settings/modules');
  });

  it('the Autotagger\'s settings page with the module off: Library care for others', () => {
    expect(go('/settings/modules/autotagger', { ...Q, tab: 'autotagger' }, withModules(EDITOR, { autotagger: false }), Q).to).toBe('/work');
    expect(go('/settings/modules/autotagger', Q, withModules(LISTENER, { autotagger: false })).to).toBe('/you');
  });

  it('a module row waits for the module\'s state', () => {
    expect(redirectFor('/settings/modules/autotagger', {})).toBeNull();
    for (const who of [OWNER, EDITOR, LISTENER]) {
      expect(redirectFor('/settings/modules/autotagger', {}, who)).toBeNull();
      expect(redirectFor('/settings/modules/autotagger', {}, withModules(who, { autotagger: null }))).toBeNull();
      expect(redirectFor('/settings/modules/dj', {}, withModules(who, { dj: null }))).toBeNull();
      expect(redirectFor('/settings/modules/listen-elsewhere', {}, who)).toBeNull();
      expect(redirectFor('/settings/modules/music-connections', {}, withModules(who, {}))).toBeNull();
    }
  });

  it('DJ, Listen elsewhere and Music Connections go to Your settings while on, the owner\'s too', () => {
    for (const who of [OWNER, EDITOR, LISTENER]) {
      expect(go('/settings/modules/dj', Q, withModules(who, ON)).to).toBe('/you/dj');
      expect(go('/settings/modules/listen-elsewhere', Q, withModules(who, ON)).to).toBe('/you/listen-elsewhere');
      expect(go('/settings/modules/music-connections', Q, withModules(who, ON)).to).toBe('/you/connections');
    }
  });

  it('DJ, Listen elsewhere and Music Connections with the module off', () => {
    const cases: Array<[string, string]> = [['/settings/modules/dj', 'dj'], ['/settings/modules/listen-elsewhere', 'listen-links'], ['/settings/modules/music-connections', 'mc']];
    for (const [path, id] of cases) {
      expect(go(path, Q, withModules(OWNER, { [id]: false })).to, path).toBe('/settings/modules');
      for (const who of [EDITOR, LISTENER]) expect(go(path, Q, withModules(who, { [id]: false })).to, path).toBe('/you/account');
    }
  });

  it('moduleStates: null while the facets load, off when the server does not name one', () => {
    expect(moduleStates(null)).toEqual({ autotagger: null, dj: null, 'listen-links': null, mc: null });
    expect(moduleStates({ autotagger: true, dj: false })).toEqual({ autotagger: true, dj: false, 'listen-links': false, mc: false });
    expect(moduleRowOf('/settings/modules/autotagger/')).toBe('autotagger');
    expect(moduleRowOf('/settings/modules/player')).toBeNull();
  });

  it('a personal return goes to Your settings whatever the module\'s state', () => {
    for (const who of [OWNER, EDITOR, LISTENER]) {
      expect(go('/settings/modules/music-connections', { linked: 'l1' }, withModules(who, OFF)).to).toBe('/you/connections');
      expect(go('/settings/modules/player', { lastfm: 'ok' }, withModules(who, OFF)).to).toBe('/you/listening');
    }
  });

  it('the switch-only module pages go to Modules', () => {
    for (const who of [undefined, OWNER, EDITOR, LISTENER]) {
      expect(go('/settings/modules/playlists', Q, who).to).toBe('/settings/modules');
      expect(go('/settings/modules/similar-artists', Q, who).to).toBe('/settings/modules');
    }
  });

  it('Genre mapping goes to its tab in one hop', () => {
    for (const who of [undefined, OWNER, EDITOR, LISTENER]) {
      expect(go('/settings/genre-mapping', Q, who, { ...Q, tab: 'genres' }).to).toBe('/work');
      expect(go('/settings/genres', Q, who, { ...Q, tab: 'genres' }).to).toBe('/work');
    }
    expect(redirectFor('/work', { tab: 'genres' })).toBeNull();
    expect(redirectFor('/work', { tab: 'genres' }, OWNER)).toBeNull();
  });

  it('Background activity keeps ?job=', () => {
    expect(redirectFor('/settings/activity', { job: 'j1' })).toEqual({ to: '/work', search: { job: 'j1', tab: 'activity' } });
    expect(redirectFor('/jobs', { job: 'j1' })).toEqual({ to: '/work', search: { job: 'j1', tab: 'activity' } });
    for (const who of [OWNER, EDITOR]) expect(go('/settings/activity', Q, who, { ...Q, tab: 'activity' }).to).toBe('/work');
    expect(go('/jobs', {}, undefined, { tab: 'activity' }).to).toBe('/work');
  });

  it('a stray tab is replaced', () => {
    expect(go('/jobs', { tab: 'review' }, undefined, { tab: 'activity' }).to).toBe('/work');
    expect(go('/settings/genre-mapping', { tab: 'activity', job: 'j1' }, undefined, { tab: 'genres', job: 'j1' }).to).toBe('/work');
  });

  it("a listener's Settings goes to Your settings", () => {
    expect(go('/settings', Q, LISTENER).to).toBe('/you');
    expect(go('/settings/modules', Q, LISTENER).to).toBe('/you');
    expect(go('/settings/modules', Q, EDITOR).to).toBe('/you');
    expect(redirectFor('/settings', {})).toBeNull();
    expect(redirectFor('/settings/modules', {})).toBeNull();
  });

  it("an editor's Settings stays", () => {
    expect(redirectFor('/settings', {}, EDITOR)).toBeNull();
    expect(redirectFor('/settings', {}, OWNER)).toBeNull();
    expect(redirectFor('/settings/tag-writing', {}, EDITOR)).toBeNull();
  });

  it('/settings/system and /settings/storage go to Status', () => {
    expect(go('/settings/system').to).toBe('/settings/status');
    expect(go('/settings/storage').to).toBe('/settings/status');
  });

  it('/settings/deleting goes to Library', () => {
    expect(go('/settings/deleting').to).toBe('/settings/library');
  });

  it('/settings/providers goes to Modules', () => {
    expect(go('/settings/providers').to).toBe('/settings/modules');
  });

  it('/settings/users goes to People', () => {
    expect(go('/settings/users').to).toBe('/settings/people');
  });

  it('/settings/metadata goes to Tag writing', () => {
    expect(go('/settings/metadata').to).toBe('/settings/tag-writing');
  });

  it('old chains are one hop', () => {
    expect(go('/settings/tag-writes').to).toBe('/settings/tag-writing');
    expect(go('/settings/follow-rules').to).toBe('/settings/following');
    expect(go('/settings/scan-roots').to).toBe('/settings/library');
    for (const from of ['/settings/tag-writes', '/settings/follow-rules', '/settings/scan-roots', '/settings/genres', '/settings/genre-mapping', '/settings/activity', '/jobs']) {
      const r = redirectFor(from, {})!;
      expect(redirectFor(r.to, r.search, withModules(OWNER, ON)), from).toBeNull();
    }
  });

  it('every /you address and every server section is left alone', () => {
    for (const who of [undefined, OWNER, EDITOR, LISTENER]) {
      expect(redirectFor('/you', {}, who)).toBeNull();
      for (const s of YOU_SECTIONS) expect(redirectFor(`/you/${s.value}`, { linked: 'l1', lastfm: 'ok' }, who)).toBeNull();
    }
    for (const who of [undefined, OWNER, EDITOR]) {
      for (const s of SERVER_SECTIONS) {
        if (s.value === 'modules' && who === EDITOR) continue;
        expect(redirectFor(`/settings/${s.value}`, {}, who), s.value).toBeNull();
      }
    }
  });

  it('a trailing slash is the same address', () => {
    expect(go('/settings/users/').to).toBe('/settings/people');
    expect(go('/settings/', Q, LISTENER).to).toBe('/you');
    expect(go('/settings/modules/player/', { lastfm: 'ok' }).to).toBe('/you/listening');
  });

  it('every target is a real section', () => {
    expect(seen.length).toBeGreaterThan(0);
    const you = new Set(YOU_SECTIONS.map((s) => `/you/${s.value}`));
    const server = new Set(SERVER_SECTIONS.map((s) => `/settings/${s.value}`));
    const tabs = new Set<unknown>(WORK_TABS);
    for (const { to, search } of seen) {
      // Library care: a real tab, or none (Review matches)
      const work = to === '/work' && (search['tab'] === undefined || tabs.has(search['tab']));
      expect(to === '/you' || you.has(to) || server.has(to) || to === '/settings/modules' || work, to).toBe(true);
    }
  });

  it('the router replaces, never pushes', () => {
    const router = source('../router.tsx');
    const uses = [...router.matchAll(/redirectFor\(/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const m of uses) {
      const after = router.slice(m.index!, m.index! + 400);
      expect(after).toMatch(/throw redirect\(\{[^}]*replace: true[^}]*\}\)/);
    }
    // the moved addresses have no routes of their own left
    expect(router).not.toMatch(/MOVED_SECTIONS/);
    expect(router).not.toMatch(/path: '\/settings\/(providers|system|scan-roots|tag-writes|genres|follow-rules)'/);
    // the old Background activity address goes through the same table
    const jobs = router.slice(router.indexOf('const jobsOldRoute'));
    expect(jobs.slice(0, jobs.indexOf('});'))).toMatch(/beforeLoad: redirectMoved/);
    expect(router).not.toMatch(/section: 'activity'/);
    const page = source('../pages/SettingsPage.tsx');
    expect(page).toMatch(/redirectFor\(/);
    expect(page).toMatch(/<Navigate\b[^>]*\breplace\b[^>]*\/>/);
  });
});
