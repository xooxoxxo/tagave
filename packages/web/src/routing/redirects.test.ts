import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { redirectFor, type Redirect } from './redirects';
import { MOVED_SECTIONS } from '../pages/moduleSettings';
import { YOU_SECTIONS } from '../pages/youSections';
import { SERVER_SECTIONS } from '../pages/settingsSections';

/*
 * Every moved address redirects to its new home (spec §8), carrying its
 * query, in one hop. Without `who` only the rows that hold for anyone
 * apply; the page adds the role rows once the role is known.
 */
const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const OWNER = { owner: true, hasSettings: true };
const EDITOR = { owner: false, hasSettings: true };
const LISTENER = { owner: false, hasSettings: false };
const Q = { job: 'j1', note: 'kept' };

/** Every target a test saw, checked against the real sections at the end. */
const seen: string[] = [];
function go(pathname: string, search: Record<string, unknown> = Q, who?: { owner: boolean; hasSettings: boolean }): Redirect {
  const r = redirectFor(pathname, search, who);
  expect(r, pathname).not.toBeNull();
  seen.push(r!.to);
  expect(r!.search).toEqual(search);
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

  it('the owner keeps the Player page', () => {
    expect(redirectFor('/settings/modules/player', {}, OWNER)).toBeNull();
    expect(redirectFor('/settings/modules/player', {})).toBeNull();
    expect(redirectFor('/settings/modules/dj', {}, OWNER)).toBeNull();
    expect(redirectFor('/settings/modules/listen-elsewhere', {}, OWNER)).toBeNull();
    expect(redirectFor('/settings/modules/music-connections', {}, OWNER)).toBeNull();
    expect(redirectFor('/settings/modules', {}, OWNER)).toBeNull();
  });

  it("a listener's module pages go to Your settings", () => {
    for (const who of [LISTENER, EDITOR]) {
      expect(go('/settings/modules/player', Q, who).to).toBe('/you/listening');
      expect(go('/settings/modules/dj', Q, who).to).toBe('/you/dj');
      expect(go('/settings/modules/listen-elsewhere', Q, who).to).toBe('/you/listen-elsewhere');
      expect(go('/settings/modules/music-connections', Q, who).to).toBe('/you/connections');
    }
    // the role rows wait for the role
    expect(redirectFor('/settings/modules/dj', {})).toBeNull();
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
    expect(go('/settings/genres').to).toBe('/settings/genre-mapping');
    for (const from of ['/settings/tag-writes', '/settings/follow-rules', '/settings/scan-roots', '/settings/genres']) {
      expect(redirectFor(redirectFor(from, {})!.to, {}, OWNER)).toBeNull();
    }
  });

  it("PR 3's moves stay put", () => {
    for (const who of [undefined, OWNER, EDITOR, LISTENER]) {
      for (const path of ['/settings/genre-mapping', '/settings/activity', '/jobs', '/settings/modules/autotagger']) {
        expect(redirectFor(path, { job: 'j1' }, who), path).toBeNull();
      }
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
    for (const to of new Set(seen)) {
      expect(to === '/you' || you.has(to) || server.has(to) || to === '/settings/modules', to).toBe(true);
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
    const page = source('../pages/SettingsPage.tsx');
    expect(page).toMatch(/redirectFor\(/);
    expect(page).toMatch(/<Navigate\b[^>]*\breplace\b[^>]*\/>/);
  });
});
