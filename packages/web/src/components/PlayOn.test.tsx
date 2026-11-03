import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { splitPrimary, type ListenLinkView } from '@tagave/shared';
import { ListenControl, PlayOnControl } from './ListenControl';
import { ListenElsewhereView } from '../pages/SettingsListenElsewherePage';

const links: ListenLinkView[] = [
  { platform: 'qobuz', name: 'Qobuz', url: 'https://play.qobuz.com/album/1', kind: 'exact' },
  { platform: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/search/x', kind: 'search' },
];

describe('Play on your service', () => {
  it('the primary platform is taken out of the Listen control; none chosen leaves it whole', () => {
    expect(splitPrimary(links, 'spotify')).toEqual({ primary: links[1], others: [links[0]] });
    expect(splitPrimary(links, null)).toEqual({ primary: null, others: links });
    expect(splitPrimary(links, 'tidal')).toEqual({ primary: null, others: links });
  });

  it('"Play on Qobuz": the embossed play key with the name, a new tab; a fallback says what it is', () => {
    const html = renderToStaticMarkup(<PlayOnControl link={links[0]!} />);
    expect(html).toContain('aria-label="Play on Qobuz"');
    expect(html).toContain('href="https://play.qobuz.com/album/1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('>Qobuz<');
    const search = renderToStaticMarkup(<PlayOnControl link={links[1]!} />);
    expect(search).toContain('aria-label="Play on Spotify (search)"');
    // one short key: the fallback is said in its name and tooltip, never as "· Search"
    expect(search).not.toContain('>Search<');
  });

  it('Listen beside it is always the Listen menu, even for one platform: no "· Search" on the card', () => {
    const html = renderToStaticMarkup(<ListenControl links={[links[1]!]} beside />);
    expect(html).toContain('aria-label="Listen"');
    expect(html).not.toContain('>Search<');
    expect(renderToStaticMarkup(<ListenControl links={[links[1]!]} />)).toContain('>Search<');
  });

  it('Settings: Missing albums offers None and the person’s own platforms', () => {
    const html = renderToStaticMarkup(<ListenElsewhereView platforms={['qobuz', 'tidal']} primary="tidal" onChange={vi.fn()} onPrimary={vi.fn()} />);
    expect(html).toContain('Missing albums');
    expect(html.match(/<option/g)).toHaveLength(3);
    expect(renderToStaticMarkup(<ListenElsewhereView platforms={[]} onChange={vi.fn()} onPrimary={vi.fn()} />)).not.toContain('Missing albums');
  });
});
