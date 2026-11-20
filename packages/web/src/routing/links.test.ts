import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { redirectFor } from './redirects';
import { SERVER_SECTIONS } from '../pages/settingsSections';
import { YOU_SECTIONS } from '../pages/youSections';
import { DEV_APP_PAGES, MODULE_PAGES } from '../pages/moduleSettings';

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

  it('the disk notice hides on Status, the page it links to', () => {
    const notice = readFileSync(join(src, 'components', 'DiskSpaceNotice.tsx'), 'utf8');
    expect(notice.includes("pathname.startsWith('/settings/status')")).toBe(true);
    expect(notice.includes('/settings/storage')).toBe(false);
  });
});
