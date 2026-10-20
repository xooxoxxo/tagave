/**
 * The account row at the foot of the sidebar and the compartment it opens:
 * one disclosure button named for the person, the section it controls
 * (identity, Account, Listening, the theme, Sign out) hidden until opened;
 * and the album's source credit, which moved from the foot of the page
 * into About.
 */
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountCompartment, accountInitial } from './AccountCompartment';
import { AlbumFacts } from '../pages/AlbumFacts';

const noop = () => undefined;
const text = (html: string) => html.replace(/<[^>]+>/g, '');
const props = { name: 'Oytun', email: 'o@home.example', onAccount: noop, onListening: noop, onSignOut: noop };
const css = readFileSync(new URL('./AccountCompartment.module.css', import.meta.url), 'utf8');

describe('AccountCompartment', () => {
  it('the tile shows the name’s first letter, else the address’s', () => {
    expect(accountInitial('oytun', 'o@home.example')).toBe('O');
    expect(accountInitial('  ', 'kim@example.com')).toBe('K');
    expect(accountInitial('Émile', 'e@x')).toBe('É');
  });

  it('a disclosure, not a menu: the row says it is closed and names the section it controls', () => {
    const html = renderToStaticMarkup(createElement(AccountCompartment, props));
    const row = html.match(/<button[^>]*aria-expanded[^>]*>/)?.[0] ?? '';
    expect(row).toMatch(/aria-expanded="false"/);
    expect(row).toMatch(/aria-label="Account: Oytun"/);
    const controls = row.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
    expect(html).not.toMatch(/role="menu|aria-haspopup/);
  });

  it('closed, the compartment is hidden; it holds who is signed in (shown on a tablet), Account, Listening, the theme and Sign out, last', () => {
    const html = renderToStaticMarkup(createElement(AccountCompartment, props));
    expect(html).not.toMatch(/data-open/);
    expect(css).toMatch(/\.compartment \{[^}]*visibility: hidden;/);
    expect(css).toMatch(/\.root\[data-open\] \.compartment \{[^}]*visibility: visible;/);
    const compartment = html.slice(html.indexOf('-compartment"'), html.lastIndexOf('<button'));
    expect(text(compartment.slice(compartment.indexOf('>') + 1))).toBe('OOytuno@home.exampleAccountListeningAppearanceLightDarkAutoSign out');
    expect(html).toMatch(/role="radiogroup" aria-label="Appearance"/);
  });

  it('open, the row says so and the section shows', () => {
    const html = renderToStaticMarkup(createElement(AccountCompartment, { ...props, defaultOpen: true }));
    expect(html).toMatch(/aria-expanded="true"/);
    expect(html).toMatch(/data-open="true"/);
  });

  it('signing out: the button says so and waits', () => {
    const html = renderToStaticMarkup(createElement(AccountCompartment, { ...props, signingOut: true, defaultOpen: true }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Signing out…<\/button>/);
  });

  it('without a name the address is the only line', () => {
    const html = renderToStaticMarkup(createElement(AccountCompartment, { ...props, name: '' }));
    const row = html.slice(html.lastIndexOf('<button'));
    expect(text(row)).toBe('Oo@home.example');
  });

  it('rings only on keyboard focus, with the app’s focus token', () => {
    expect(css).toMatch(/\.row:focus \{ outline: none; \}/);
    expect(css).toMatch(/\.row:focus-visible \{ outline: var\(--focus-ring\)/);
    expect(css).toMatch(/\.item:focus-visible \{ outline: var\(--focus-ring\)/);
  });

  it('the row is the bar’s height and paint, square, edge to edge; the compartment animates its height', () => {
    expect(css).toMatch(/html\[data-player-bar\]\) \.row \{ height: var\(--player-bar-h, 72px\)/);
    expect(css).toMatch(/--strip: linear-gradient\(var\(--glass\), var\(--glass\)\), var\(--canvas\)/);
    expect(css).toMatch(/\.row \{[^}]*border-radius: 0;/);
    expect(css).toMatch(/grid-template-rows 200ms/);
    expect(css).toMatch(/prefers-reduced-motion[^{]*\{[^}]*\.compartment[^}]*transition: none/);
  });

  it('the identity line shows only where the row is the tile alone (tablet)', () => {
    expect(css).toMatch(/\.identity \{\s*display: none;/);
    expect(css).toMatch(/@media \(min-width: 721px\) and \(max-width: 900px\) \{[\s\S]*\.identity \{ display: flex; \}/);
  });
});

describe('AlbumFacts source line', () => {
  it('Discogs’ attribution and the MusicBrainz release end About', () => {
    const html = renderToStaticMarkup(createElement(AlbumFacts, { facts: [['Released', '2012']], source: { discogs: true, mbid: 'abc' } }));
    expect(html).toMatch(/<a href="https:\/\/www\.discogs\.com"[^>]*>Data provided by Discogs<\/a>/);
    expect(html).toMatch(/href="https:\/\/musicbrainz\.org\/release\/abc"/);
  });

  it('nothing from Discogs or MusicBrainz: no line', () => {
    const html = renderToStaticMarkup(createElement(AlbumFacts, { facts: [['Released', '2012']], source: {} }));
    expect(html).not.toMatch(/data-album-source/);
  });
});
