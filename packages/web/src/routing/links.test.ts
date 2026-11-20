import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { redirectFor } from './redirects';
import { SERVER_SECTIONS } from '../pages/settingsSections';
import { YOU_SECTIONS } from '../pages/youSections';
import { DEV_APP_PAGES, MODULE_PAGES } from '../pages/moduleSettings';
import { WORK_TABS } from '../pages/workTabs';

/*
 * No link, notice or navigate inside the app points at an address that
 * redirects (spec §8): each one names the new home itself. Reads the
 * source, so a new stale link fails here rather than costing a hop.
 */
const src = fileURLToPath(new URL('../', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return [path];
  });
const files = walk(src).filter(
  (f) => /\.tsx?$/.test(f) && !/\.(test|stories)\.tsx?$/.test(f) && !f.endsWith(join('routing', 'redirects.ts')) && !f.includes(`${join('src', 'stories')}`),
);
const rel = (file: string) => file.slice(src.length);

type Found = { file: string; path: string };

/** A route literal: '/settings…', '/you…' or '/jobs', in quotes. */
const LITERAL = /(['"`])(\/(?:settings|you|jobs)(?:\/[^'"`\s]*)?)\1/g;
/** The literal is a link target: `to=`, `to:`, or a branch of a ternary inside `to={…}`. */
const LINK_BEFORE = /\bto\s*[=:]\s*\{?(?:[^;<>\n]*?[?:]\s*)?$/;
/** A literal param for a `$section` or `$module` route, read just after the route. */
const PARAM = /\b(section|module)\s*:\s*(['"])([^'"]+)\2/;

function linksIn(file: string): Found[] {
  const text = readFileSync(file, 'utf8');
  const found: Found[] = [];
  for (const m of text.matchAll(LITERAL)) {
    const at = m.index!;
    if (!LINK_BEFORE.test(text.slice(Math.max(0, at - 80), at))) continue;
    let path = m[2]!;
    if (path.includes('${')) continue; // built at run time (a nav list's own sections)
    const dynamic = /\$(section|module)$/.exec(path);
    if (dynamic) {
      const after = text.slice(at + m[0].length, at + m[0].length + 240);
      const param = PARAM.exec(after);
      if (!param || param[1] !== dynamic[1]) continue; // a param from a variable, checked by its own module
      path = path.replace(`$${dynamic[1]}`, param[3]!);
    }
    found.push({ file: rel(file), path });
  }
  return found;
}

const links = files.flatMap(linksIn);
const show = (list: Found[]) => list.map((l) => `${l.file}: ${l.path}`);

describe('in-app settings links', () => {
  it('finds the links it checks', () => {
    // a scanner that matches nothing would pass every test below
    expect(links.length).toBeGreaterThan(20);
    expect(links.some((l) => l.path === '/settings/library')).toBe(true);
  });

  it('no in-app link hits a redirect', () => {
    const stale = links.filter((l) => redirectFor(l.path, {}, { owner: true, hasSettings: true }) !== null);
    expect(show(stale)).toEqual([]);
  });

  it('no in-app link hits a redirect a non-owner gets', () => {
    // Modules itself is the owner's page; its parts move to Your settings for everyone else.
    // Links shown only to the owner are listed here by file and address.
    const ownerOnly = new Set(['pages/YouPage.tsx: /settings/modules/player']);
    const stale = links.filter(
      (l) =>
        l.path !== '/settings/modules' &&
        !ownerOnly.has(`${l.file}: ${l.path}`) &&
        redirectFor(l.path, {}, { owner: false, hasSettings: true }) !== null,
    );
    expect(show(stale)).toEqual([]);
  });

  it('nothing links to /jobs', () => {
    expect(show(links.filter((l) => l.path === '/jobs'))).toEqual([]);
  });

  it('each /settings/<x> is a real server section', () => {
    const servers = new Set(SERVER_SECTIONS.map((s) => s.value));
    const bad = links.filter((l) => {
      const parts = l.path.split('/');
      return parts[1] === 'settings' && parts.length >= 3 && !servers.has(parts[2]!);
    });
    expect(show(bad)).toEqual([]);
  });

  it('each /settings/modules/<x> is a real module page', () => {
    const modules = new Set([...MODULE_PAGES, ...DEV_APP_PAGES].map((m) => m.slug));
    const bad = links.filter((l) => {
      const parts = l.path.split('/');
      return parts[2] === 'modules' && parts.length >= 4 && !modules.has(parts[3]!);
    });
    expect(show(bad)).toEqual([]);
  });

  it('each /you/<x> is a real section of Your settings', () => {
    const yours = new Set(YOU_SECTIONS.map((s) => s.value));
    const bad = links.filter((l) => {
      const parts = l.path.split('/');
      return parts[1] === 'you' && parts.length >= 3 && !yours.has(parts[2]!);
    });
    expect(show(bad)).toEqual([]);
  });

  it('each /work link names a real tab', () => {
    const tabs = new Set<string>(WORK_TABS);
    const found: Array<{ file: string; tab: string }> = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bto\s*[=:]\s*(['"])\/work\1/g)) {
        const tab = /\btab:\s*'([^']+)'/.exec(text.slice(m.index!, m.index! + 160));
        if (tab) found.push({ file: rel(file), tab: tab[1]! });
      }
    }
    expect(found.length).toBeGreaterThanOrEqual(5);
    expect(found.filter((f) => !tabs.has(f.tab)).map((f) => `${f.file}: ${f.tab}`)).toEqual([]);
  });

  it("a link into a module's place sits behind its module", () => {
    // Each file listed here links into a module's place only from inside that
    // module's own part (so the module is on by construction). A new link
    // elsewhere fails until it renders only while its module is on and is
    // listed here.
    const allowed = new Set([
      // the Getting tab shows only while Lidarr is on; it links Lidarr's page
      'pages/GettingPage.tsx: /settings/modules/lidarr',
      // PlayerServerRow sits in the Listening section, shown only while the player is on
      'pages/YouPage.tsx: /settings/modules/player',
    ]);
    const exempt = (file: string) => file === join('pages', 'SettingsModulesPage.tsx') || file === join('pages', 'youSections.ts') || file.startsWith('routing/');
    const modulePlace = /^\/you\/(listening|dj|listen-elsewhere|connections)$|^\/settings\/modules\/[^/]+$/;
    const places: string[] = links.filter((l) => !exempt(l.file) && modulePlace.test(l.path)).map((l) => `${l.file}: ${l.path}`);
    for (const file of files) {
      if (exempt(rel(file))) continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bto\s*[=:]\s*(['"])\/work\1/g)) {
        const tab = /\btab:\s*'(autotagger|getting)'/.exec(text.slice(m.index!, m.index! + 160));
        if (tab) places.push(`${rel(file)}: /work?tab=${tab[1]}`);
      }
    }
    expect(places.filter((p) => !allowed.has(p))).toEqual([]);
  });

  it('the disk notice hides on Status, the page it links to', () => {
    const notice = readFileSync(join(src, 'components', 'DiskSpaceNotice.tsx'), 'utf8');
    expect(notice.includes("pathname.startsWith('/settings/status')")).toBe(true);
    expect(notice.includes('/settings/storage')).toBe(false);
  });
});
