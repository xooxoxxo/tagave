/**
 * The desktop sidebar's foot: every page listed as a real link (nothing
 * opens on a press), the theme, and the person on the last row with the
 * way out beside them.
 */
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SidebarAccount, type SidebarAccountLink } from './SidebarAccount';

const noop = () => undefined;
const text = (html: string) => html.replace(/<[^>]+>/g, '');
const links: SidebarAccountLink[] = [
  { key: 'listening', label: 'Listening', href: '/settings/modules/player', onSelect: noop },
  { key: 'work', label: 'Library care', href: '/work?tab=review', onSelect: noop, count: 3, countLabel: 'open tasks', current: true },
  { key: 'plans', label: 'Tag changes', href: '/plans', onSelect: noop },
  { key: 'settings', label: 'Settings', href: '/settings', onSelect: noop, dot: 'a new version is available' },
];
const props = { name: 'Oytun', email: 'o@home.example', links, account: { href: '/settings/account', onSelect: noop }, onSignOut: noop };
const css = readFileSync(new URL('./SidebarAccount.module.css', import.meta.url), 'utf8');

describe('SidebarAccount', () => {
  it('lists the pages as links, in order, with nothing to open first', () => {
    const html = renderToStaticMarkup(createElement(SidebarAccount, props));
    const hrefs = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['/settings/modules/player', '/work?tab=review', '/plans', '/settings', '/settings/account']);
    expect(html).not.toMatch(/aria-expanded|aria-haspopup|role="menu/);
  });

  it('the page being shown is marked; a count and a dot are read out', () => {
    const html = renderToStaticMarkup(createElement(SidebarAccount, props));
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(text(html)).toContain('Library care, 3 open tasks');
    expect(text(html)).toContain('Settings (a new version is available)');
  });

  it('the person names the account; Sign out is a button with a name, and says when it is busy', () => {
    const html = renderToStaticMarkup(createElement(SidebarAccount, props));
    expect(html).toMatch(/aria-label="Account: Oytun"/);
    expect(html).toMatch(/<button[^>]*aria-label="Sign out"/);
    const busy = renderToStaticMarkup(createElement(SidebarAccount, { ...props, signingOut: true }));
    expect(busy).toMatch(/<button[^>]*aria-label="Signing out"[^>]*disabled/);
  });

  it('a failed sign-out is announced', () => {
    const html = renderToStaticMarkup(createElement(SidebarAccount, { ...props, signOutFailed: true }));
    expect(html).toMatch(/role="alert"[^>]*>Could not sign out/);
  });

  it('no name: the address stands in', () => {
    const html = renderToStaticMarkup(createElement(SidebarAccount, { ...props, name: '  ' }));
    expect(html).toMatch(/aria-label="Account: o@home.example"/);
  });

  it('the focus ring is for the keyboard only', () => {
    expect(css).not.toMatch(/:focus\s*\{[^}]*outline:\s*var/);
    expect(css).toMatch(/\.link:focus-visible/);
  });
});
