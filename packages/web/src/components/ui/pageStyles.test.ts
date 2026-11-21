import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Page and feature CSS (everything outside components/ui) stays on the design
 * system: colours come from tokens so both themes work, no control gets the
 * old small radius, and a class on an h1/h2 never asks the thin display face
 * for a weight it is not loaded in (that would be a synthesised bold).
 */
const src = fileURLToPath(new URL('../../', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'ui' ? [] : walk(path);
    return [path];
  });
const walkAll = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walkAll(path) : [path];
  });
const files = [...walk(join(src, 'pages')), ...walk(join(src, 'components'))];
const cssFiles = files.filter(f => f.endsWith('.module.css'));
const tsxFiles = files.filter(f => f.endsWith('.tsx') && !f.endsWith('.test.tsx'));
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const css = (file: string) => stripComments(readFileSync(file, 'utf8'));
const rel = (file: string) => file.slice(src.length);

describe('page CSS', () => {
  it('finds the page styles', () => {
    expect(cssFiles.length).toBeGreaterThan(20);
  });

  it.each(cssFiles.map(f => [rel(f), f]))('%s uses colour tokens, not literals', (_name, file) => {
    const source = css(file);
    expect(source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(source.match(/rgba?\(\s*\d/g) ?? []).toEqual([]);
    expect(source.match(/:\s*(white|black)\s*[;}]/g) ?? []).toEqual([]);
  });

  it.each(cssFiles.map(f => [rel(f), f]))('%s has no small literal radius', (_name, file) => {
    const small = [...css(file).matchAll(/border-radius:\s*([^;}]+)/g)]
      .map(m => m[1]!.trim())
      .filter(value => /\b([1-9]|1[0-2])px\b/.test(value));
    expect(small).toEqual([]);
  });
});

describe('h1 and h2 classes', () => {
  const offenders: string[] = [];
  for (const tsx of tsxFiles) {
    const source = readFileSync(tsx, 'utf8');
    const imported = source.match(/import styles from '([^']+\.module\.css)'/);
    if (!imported) continue;
    const classes = new Set([...source.matchAll(/<h[12][^>]*className=\{styles\.([A-Za-z0-9_]+)\}/g)].map(m => m[1]!));
    if (classes.size === 0) continue;
    const cssFile = resolve(dirname(tsx), imported[1]!);
    for (const match of css(cssFile).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = match[1]!.split(',').map(s => s.trim());
      const onlyHeadings = selectors.every(s => {
        const m = s.match(/^\.([A-Za-z0-9_]+)$/);
        return m && classes.has(m[1]!);
      });
      const weight = match[2]!.match(/font-weight:\s*(\d+)/);
      if (onlyHeadings && weight && Number(weight[1]) > 400) offenders.push(`${rel(cssFile)} ${match[1]!.trim()} ${weight[0]}`);
    }
  }

  it('never set a weight above 400 (Urbanist is loaded at 200 to 400)', () => {
    expect(offenders).toEqual([]);
  });
});

/*
 * The settings pages are built from SettingsGroup and SettingsRow, so their
 * own CSS is only what is left over: a class nothing uses any more is dead,
 * and no page styles a heading (the section's h2 is the frame's, a group's
 * h3 is SettingsGroup's). The frame (SettingsPage.module.css) may hide its
 * own h2 on a phone and during an update; release notes rendered from
 * Markdown (.markdown) are content, not settings headings. A class counts as
 * used only when named statically (styles.x or styles['x']): one picked at
 * runtime (styles[variant]) would read as dead.
 */
describe('settings CSS', () => {
  const settingsModules = [
    'pages/SettingsPage.module.css',
    'pages/SettingsSecurityPage.module.css',
    'pages/SettingsListeningPage.module.css',
    'pages/SettingsDjPage.module.css',
    'pages/SettingsListenElsewherePage.module.css',
    'pages/SettingsConnectionsPage.module.css',
    'pages/SettingsScanRootsPage.module.css',
    'components/naming/Naming.module.css',
    'pages/SettingsDeletingPage.module.css',
    'pages/SettingsTagWritesPage.module.css',
    'pages/SettingsFollowRulesPage.module.css',
    'pages/SettingsGenresPage.module.css',
    'components/users/UsersList.module.css',
    'pages/SettingsProvidersPage.module.css',
    'pages/SettingsPlaybackPage.module.css',
    'components/LidarrSettings.module.css',
    'pages/SettingsUpdatesPage.module.css',
    'pages/Settings/SystemStatus.module.css',
    'pages/SettingsStoragePage.module.css',
    'pages/SettingsBackupsPage.module.css',
    'pages/SettingsModulesPage.module.css',
  ];
  const sources = walkAll(src).filter(f => /\.(tsx?|jsx?)$/.test(f) && !/\.test\./.test(f));
  const importersOf = (cssFile: string) =>
    sources.flatMap(file => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+'([^']+\.module\.css)'/g)]
        .filter(m => resolve(dirname(file), m[2]!) === cssFile)
        .map(m => ({ name: m[1]!, source }));
    });
  const definedClasses = (source: string) => {
    const selectors = [...source.matchAll(/([^{}]+)\{/g)].map(m => m[1]!).filter(s => !s.trim().startsWith('@'));
    const names = new Set<string>();
    for (const selector of selectors) {
      const local = selector.replace(/:global\([^)]*\)/g, '');
      for (const m of local.matchAll(/\.(-?[_A-Za-z][\w-]*)/g)) names.add(m[1]!);
    }
    return [...names];
  };

  it('finds every settings page module', () => {
    expect(settingsModules.filter(f => !cssFiles.includes(join(src, f)))).toEqual([]);
  });

  it.each(settingsModules.map(f => [f]))('%s has no dead class', file => {
    const cssFile = join(src, file);
    const importers = importersOf(cssFile);
    expect(importers.length).toBeGreaterThan(0);
    const used = (name: string) =>
      importers.some(({ name: id, source }) => {
        const escaped = name.replace(/[-]/g, '\\-');
        return new RegExp(`\\b${id}\\.${escaped}\\b(?!-)`).test(source) || new RegExp(`\\b${id}\\[['"\`]${escaped}['"\`]\\]`).test(source);
      });
    expect(definedClasses(css(cssFile)).filter(name => !used(name))).toEqual([]);
  });

  it.each(settingsModules.map(f => [f]))('%s styles no heading', file => {
    const frame = file === 'pages/SettingsPage.module.css';
    const offenders = [...css(join(src, file)).matchAll(/([^{}]+)\{/g)]
      .flatMap(m => m[1]!.split(','))
      .map(s => s.trim())
      .filter(s => !s.startsWith('@') && /(^|[\s>+~(])h[23]\b/.test(s))
      .filter(s => !(frame && /> \.content > h2:first-child$/.test(s)))
      .filter(s => !/^\.markdown\s+h[23]$/.test(s));
    expect(offenders).toEqual([]);
  });
});
