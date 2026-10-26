import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ListenLinkView } from '@tagave/shared';
import { ListenControl, listenLabel } from './ListenControl';
import { AlbumActionsBody } from '../pages/AlbumMenu';
import { albumMenu, albumMenuItems } from '../pages/albumActions';
import { ListenElsewhereView } from '../pages/SettingsListenElsewherePage';

const qobuz: ListenLinkView = { platform: 'qobuz', name: 'Qobuz', url: 'https://play.qobuz.com/album/0634904078164', kind: 'exact' };
const spotify: ListenLinkView = { platform: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb', kind: 'artist' };
const tidal: ListenLinkView = { platform: 'tidal', name: 'Tidal', url: 'https://tidal.com/search?q=Radiohead%20OK%20Computer', kind: 'search' };

describe('the Listen control', () => {
  it('one platform: a direct link with its name, in a new tab, never the opener', () => {
    const html = renderToStaticMarkup(<ListenControl links={[qobuz]} />);
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="https://play.qobuz.com/album/0634904078164"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('aria-label="Listen on Qobuz"');
    expect(html.replace(/<[^>]+>/g, '')).toBe('Qobuz');
    expect(html).toMatch(/class="[^"]*emboss[^"]*page/);
  });

  it('a link that is not the album says what it is', () => {
    const html = renderToStaticMarkup(<ListenControl links={[tidal]} />);
    expect(html.replace(/<[^>]+>/g, '')).toBe('TidalSearch');
    expect(html).toContain('aria-label="Listen on Tidal (search)"');
    expect(listenLabel(spotify)).toBe('Listen on Spotify (artist page)');
  });

  it('several: one "Listen" key that opens a menu (the same embossed shape)', () => {
    const html = renderToStaticMarkup(<ListenControl links={[qobuz, spotify]} />);
    expect(html).toContain('aria-label="Listen"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toMatch(/class="[^"]*emboss[^"]*page/);
    expect(html).not.toContain('<a ');
  });

  it('nothing at all without links', () => {
    expect(renderToStaticMarkup(<ListenControl links={[]} />)).toBe('');
  });
});

describe('Listen in the album’s ⋮', () => {
  const base = { canCare: false, maintenance: false, artists: [], onInfo: () => undefined, onToggleMaintenance: () => undefined };

  it('the dropdown lists each platform as a link, the inexact ones marked', () => {
    const items = albumMenuItems(albumMenu({ ...base, listen: [qobuz, spotify, tidal] }));
    const listen = items.filter((i) => i.key.startsWith('listen-'));
    expect(listen).toEqual([
      { key: 'listen-qobuz', label: 'Listen on Qobuz', href: qobuz.url, separated: true },
      { key: 'listen-spotify', label: 'Listen on Spotify', href: spotify.url, hint: 'Artist page' },
      { key: 'listen-tidal', label: 'Listen on Tidal', href: tidal.url, hint: 'Search' },
    ]);
  });

  it('the drawer has a Listen group of links; without links the menu is as before', () => {
    const html = renderToStaticMarkup(<AlbumActionsBody summary={{ coverUrl: null, title: 'OK Computer', artist: 'Radiohead', kicker: [] }} model={albumMenu({ ...base, listen: [qobuz, tidal] })} onClose={vi.fn()} />);
    expect(html).toContain('>Listen</h2>');
    expect(html).toContain('data-menu-row="listen-qobuz"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('>Search<');
    expect(albumMenu(base)).not.toHaveProperty('listen');
    expect(albumMenu({ ...base, listen: [] })).not.toHaveProperty('listen');
  });
});

describe('Settings › Listen elsewhere', () => {
  it('none ticked until the person chooses; ticking keeps the list’s order', () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(<ListenElsewhereView platforms={[]} onChange={onChange} />);
    expect(html.match(/type="checkbox"/g)).toHaveLength(8);
    expect(html).not.toContain('checked');
    for (const name of ['Qobuz', 'Spotify', 'Apple Music', 'YouTube Music', 'Tidal', 'Bandcamp', 'Amazon Music', 'Deezer']) expect(html).toContain(`<span>${name}</span>`);
    const ticked = renderToStaticMarkup(<ListenElsewhereView platforms={['qobuz', 'tidal']} onChange={onChange} />);
    expect(ticked.match(/checked=""/g)).toHaveLength(2);
  });
});
