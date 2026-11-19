/**
 * The identity row at the top of the sidebar: the mark (home), the
 * wordmark, search when it sits beside, and the person's monogram that
 * opens their menu.
 */
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IdentityRow } from './IdentityRow';

const noop = () => undefined;
const text = (html: string) => html.replace(/<[^>]+>/g, '');
const props = {
  name: 'Robin',
  email: 'robin@example.com',
  showWordmark: true,
  canCare: true,
  dot: null,
  onNavigate: noop,
  onSignOut: noop,
};
const render = (over: Partial<Parameters<typeof IdentityRow>[0]> = {}) => renderToStaticMarkup(createElement(IdentityRow, { ...props, ...over }));
const css = readFileSync(new URL('./IdentityRow.module.css', import.meta.url), 'utf8');

describe('IdentityRow', () => {
  it('the mark links home and the wordmark follows the pref', () => {
    const html = render();
    expect(html).toMatch(/<a [^>]*href="\/"/);
    expect(text(html)).toContain('tagave');
    expect(text(render({ showWordmark: false }))).not.toContain('tagave');
  });

  it('the monogram names the person and the update', () => {
    expect(render({ dot: 'a new version is available' })).toContain('aria-label="Account: Robin, a new version is available"');
    const plain = render();
    expect(plain).toContain('aria-label="Account: Robin"');
    expect(plain).not.toContain(', a new version');
  });

  it('blank name falls back to the email', () => {
    expect(render({ name: '  ' })).toContain('aria-label="Account: robin@example.com"');
  });

  it('search sits between the wordmark and the monogram when given', () => {
    const html = render({ search: createElement('span', { 'data-testid': 'search-slot' }) });
    const at = html.indexOf('search-slot');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(html.indexOf('tagave</'));
    expect(at).toBeLessThan(html.indexOf('Account:'));
  });

  it('the monogram is a 32px tile with a 44px hit area on touch', () => {
    expect(css).toMatch(/\.tile\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px/);
    const touch = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(touch).toMatch(/^@media \(pointer: coarse\) \{\s*\.tile::before \{ content: ''; position: absolute; inset: -6px; \}/);
  });

  it('sign-out failure is announced', () => {
    expect(render()).not.toContain('role="alert"');
    expect(render({ signOutFailed: true })).toMatch(/<p role="alert"[^>]*>Could not sign out\. Please try again\.<\/p>/);
  });

  it('a long name truncates', () => {
    expect(css).toMatch(/\.name\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.tile\s*\{[^}]*flex:\s*none/);
  });
});
