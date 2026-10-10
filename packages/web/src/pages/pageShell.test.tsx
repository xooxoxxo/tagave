import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageBackContext, PageShell } from '../components/ui/PageShell';

/*
 * One page shell: every page inside the app frame renders PageShell, so the
 * heading's left edge, the column's width and the top padding never change
 * between pages. Detail pages put the back button inline before the title;
 * Maintenance is switched only where it changes something (the album page).
 */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const css = (rel: string) => stripComments(source(rel));
const rule = (text: string, selector: string) =>
  [...text.matchAll(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((m) => m[1] ?? '').join('\n');

const router = source('../router.tsx');
/** Components routed under the app frame (getParentRoute: layoutRoute). */
const framed = [...router.matchAll(/getParentRoute: \(\) => layoutRoute,[^}]*?component: (\w+)/g)].map((m) => m[1]!);
/** Not a page in the frame's rhythm: a narrow, centred first-run wizard. */
const EXEMPT = new Set(['OnboardingPage']);
const fileFor = (component: string) => `./${component}.tsx`;

describe('page shell contract', () => {
  it('finds the framed pages', () => {
    for (const page of ['DashboardPage', 'AlbumsPage', 'AlbumDetailPage', 'ArtistsPage', 'ArtistPage', 'WorkPage', 'PlansPage', 'PlanPage', 'CollectionPage', 'SettingsPage']) {
      expect(framed).toContain(page);
    }
  });

  it.each([...new Set(framed)].filter((c) => !EXEMPT.has(c)))('%s renders inside PageShell', (component) => {
    expect(source(fileFor(component))).toMatch(/<PageShell\b/);
  });

  it.each([...new Set(framed)].filter((c) => !EXEMPT.has(c)))('%s sets no column width or edge of its own', (component) => {
    const tsx = source(fileFor(component));
    const cssFile = tsx.match(/import styles from '(\.\/[^']+\.module\.css)'/)?.[1];
    if (!cssFile) return;
    // the column (max width, centring) belongs to the shell alone
    expect(css(cssFile)).not.toMatch(/max-width:\s*(calc\()?var\(--content-max\)/);
  });

  it('detail pages lead their title with the back button', () => {
    for (const page of ['ArtistPage', 'PlanPage']) {
      expect(source(fileFor(page))).toMatch(/<PageShell\s+back\b/);
    }
    // the album's own header carries it inline before the title
    const album = source('./AlbumDetailPage.tsx');
    expect(album).toMatch(/<PageBack \/>\s*<h1 ref=\{titleRef\}/);
  });

  it('the shell owns the edge, width and top padding', () => {
    const tokens = css('../styles/tokens.css');
    expect(tokens).toMatch(/--page-top:\s*var\(--page-pad\)/);
    expect(tokens).toMatch(/--shell-gutter:\s*max\(var\(--page-pad\), calc\(\(100% - var\(--content-max\)\) \/ 2 \+ var\(--page-pad\)\)\)/);
    const shell = css('../components/ui/PageShell.module.css');
    expect(rule(shell, '.header')).toMatch(/padding:\s*var\(--page-top\) var\(--shell-gutter\)/);
    expect(rule(shell, '.content')).toMatch(/padding:\s*[^;]*var\(--shell-gutter\)/);
    expect(rule(shell, '.tabs')).toMatch(/padding-inline:\s*var\(--shell-gutter\)/);
  });
});

describe('PageShell markup', () => {
  const back = () => createElement('button', { 'aria-label': 'Back' });

  it('puts the back button in the title row, before the heading', () => {
    const html = renderToStaticMarkup(createElement(PageBackContext.Provider, { value: back },
      createElement(PageShell, { back: true, title: 'Porcelain Tree', children: null })));
    expect(html).toMatch(/class="[^"]*titleRow[^"]*"><span class="[^"]*back[^"]*"><button aria-label="Back"><\/button><\/span><h1[^>]*>Porcelain Tree<\/h1>/);
  });

  it('a top-level page has no back button, even with a provider', () => {
    const html = renderToStaticMarkup(createElement(PageBackContext.Provider, { value: back },
      createElement(PageShell, { title: 'Artists', children: null })));
    expect(html).not.toContain('aria-label="Back"');
  });

  it('a filling page marks itself for the frame (virtual lists)', () => {
    const html = renderToStaticMarkup(createElement(PageShell, { fill: true, title: 'Albums', children: null }));
    expect(html).toMatch(/data-page-shell="" data-virtual-page=""/);
  });
});

describe('Maintenance lives where it changes something', () => {
  const layout = source('../components/Layout.tsx');

  it('the sidebar has no Maintenance toggle; the phone bar has it on album pages only', () => {
    expect(layout).not.toMatch(/maintenanceToggle/);
    expect(layout).toMatch(/onAlbumPage \? <MaintenanceToggle className=\{styles\.phoneModeToggle\} \/> : <MaintenancePill/);
    expect(rule(css('../components/Layout.module.css'), '.phoneModeToggle')).toMatch(/display:\s*none/);
  });

  it('Shift+M still switches it anywhere', () => {
    expect(layout).toMatch(/isMaintenanceShortcut\(e, e\.target\)/);
  });

  it('the album header carries the switch next to "⋯"', () => {
    const album = source('./AlbumDetailPage.tsx');
    const row = album.slice(album.indexOf('className={styles.actionRow}'));
    expect(row.indexOf('<MaintenanceToggle')).toBeGreaterThan(-1);
    expect(row.indexOf('<MaintenanceToggle')).toBeLessThan(row.indexOf('<Menu '));
  });
});
