/**
 * Settings: the section list stays put while a section scrolls, under a
 * sticky header; on a phone the list and each section are pages of their
 * own and the top bar names the page instead of showing the wordmark.
 */
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageShell } from '../components/ui/PageShell';

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const block = (css: string, selector: string) => {
  const i = css.indexOf(`${selector} {`);
  if (i < 0) throw new Error(`no ${selector}`);
  return css.slice(i, css.indexOf('}', i));
};
/** The body of the first `@media (max-width: 720px)` block holding `needle`. */
const phoneBlock = (css: string, needle: string) => {
  const parts = css.split('@media (max-width: 720px)').slice(1);
  const hit = parts.find((p) => p.includes(needle));
  if (!hit) throw new Error(`no phone rule with ${needle}`);
  return hit;
};

describe('settings: sticky header and section list', () => {
  it('the page asks for a sticky header and marks which view it shows', () => {
    const tsx = source('./SettingsPage.tsx');
    expect(tsx).toMatch(/<PageShell title="Settings" sticky>/);
    expect(tsx).toMatch(/data-view=\{view\}/);
    expect(tsx).toMatch(/usePhoneSubpage\(/);
  });

  it('a sticky shell header sticks to the top of the pane, frosted', () => {
    const css = read('../components/ui/PageShell.module.css');
    const sticky = block(css, '.headerSticky');
    expect(sticky).toMatch(/composes:\s*header/);
    expect(sticky).toMatch(/position:\s*sticky/);
    expect(sticky).toMatch(/top:\s*0/);
    expect(sticky).toMatch(/background:/);
  });

  it('the shell renders the sticky header and marks a heading-only header', () => {
    const html = renderToStaticMarkup(createElement(PageShell, { title: 'Settings', sticky: true, children: 'x' }));
    expect(html).toMatch(/<header class="[^"]*headerSticky[^"]*" data-title-only="">/);
    expect(html).toMatch(/<h1 class="[^"]*" data-page-title="">Settings<\/h1>/);
    const plain = renderToStaticMarkup(createElement(PageShell, { title: 'Albums', aside: '12', children: 'x' }));
    expect(plain).not.toMatch(/headerSticky/);
    expect(plain).not.toMatch(/data-title-only/);
    const detail = renderToStaticMarkup(createElement(PageShell, { title: 'Plan', back: true, children: 'x' }));
    expect(detail).not.toMatch(/data-page-title/);
  });

  it('the section list sticks under the header and scrolls on its own', () => {
    const css = read('./SettingsPage.module.css');
    const nav = block(css, '.sectionNav');
    expect(nav).toMatch(/position:\s*sticky/);
    expect(nav).toMatch(/top:\s*calc\(var\(--shell-header-h, 0px\) \+ 1\.5rem\)/);
    expect(nav).toMatch(/max-height:\s*calc\(var\(--pane-h, 100dvh\)/);
    expect(nav).toMatch(/overflow-y:\s*auto/);
  });

  it('phone: the list or the section, never both; the section heading left to screen readers', () => {
    const phone = phoneBlock(read('./SettingsPage.module.css'), 'data-view');
    expect(phone).toMatch(/\.layout\[data-view="list"\] > \.content \{ display: none; \}/);
    expect(phone).toMatch(/\.layout\[data-view="section"\] > \.sectionNav \{ display: none; \}/);
    expect(phone).toMatch(/\.sectionNav \{ position: static;/);
  });
});

describe('phone top bar: the page name in place of the wordmark', () => {
  it('the bar renders the page title and a back key for a sub-page', () => {
    const tsx = source('../components/Layout.tsx');
    expect(tsx).toMatch(/const title = pageTitle\(pathname\)/);
    expect(tsx).toMatch(/<span className=\{styles\.pageTitle\} aria-hidden="true">\{title\}<\/span>/);
    expect(tsx).toMatch(/<span className=\{styles\.wordmark\}>tagave<\/span>/);
    expect(tsx).toMatch(/navigate\(\{ to: subpage\.up \}\)/);
  });

  it('on a phone the wordmark goes, the title shows, the page heading is screen-reader only', () => {
    const css = read('../components/Layout.module.css');
    expect(block(css, '.pageTitle')).toMatch(/display:\s*none/);
    const phone = phoneBlock(css, '.wordmark');
    expect(phone).toMatch(/\.wordmark \{ display: none; \}/);
    expect(phone).toMatch(/\.pageTitle \{ display: block;/);
    expect(phone).toMatch(/\.page \[data-page-title\] \{ position: absolute;/);
    expect(phone).toMatch(/\.page \[data-title-only\] \{ padding: var\(--page-top\) 0 0;/);
    // a detail page (back key) and a sub-page trade the mark and the name for the back bar
    expect(css).toMatch(/\.navDetail \.brand, \.navDetail \.pageTitle \{ display: none; \}/);
  });
});
