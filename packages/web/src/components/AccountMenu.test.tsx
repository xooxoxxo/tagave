/**
 * The account row at the foot of the sidebar: the initial tile, the name
 * and address as one button named for the person, its menu (Account,
 * Listening, Sign out); and the album's source credit, which moved from the
 * foot of the page into About.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountMenu, accountInitial } from './AccountMenu';
import { AlbumFacts } from '../pages/AlbumFacts';

const noop = () => undefined;
const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('AccountMenu', () => {
  it('the tile shows the name’s first letter, else the address’s', () => {
    expect(accountInitial('oytun', 'o@home.example')).toBe('O');
    expect(accountInitial('  ', 'kim@example.com')).toBe('K');
    expect(accountInitial('Émile', 'e@x')).toBe('É');
  });

  it('one button: the name and the address, named for the person, opening a menu', () => {
    const html = renderToStaticMarkup(createElement(AccountMenu, { name: 'Oytun', email: 'o@home.example', onAccount: noop, onListening: noop, onSignOut: noop }));
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="Account: Oytun"/);
    expect(html).toMatch(/aria-haspopup="menu"/);
    expect(text(html)).toBe('OOytuno@home.example');
    expect(html).not.toMatch(/Sign out/);
  });

  it('without a name the address is the only line', () => {
    const html = renderToStaticMarkup(createElement(AccountMenu, { name: '', email: 'o@home.example', onAccount: noop, onListening: noop, onSignOut: noop }));
    expect(text(html)).toBe('Oo@home.example');
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
