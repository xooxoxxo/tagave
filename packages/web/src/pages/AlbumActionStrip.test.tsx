import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AlbumActionStrip, PLAY_NOTE_ID, type AlbumActionStripProps } from './AlbumActionStrip';
import { AlbumFlowHeader, type AlbumFlowHeaderProps } from './AlbumFlowHeader';
import { albumActionContext } from './albumActions';

const menu = { label: 'More for this album', items: [{ key: 'mode', label: 'Turn on Maintenance', onSelect: vi.fn() }] };
const owner = albumActionContext({ canCare: true, playerInstalled: true, maintenance: false });
const listener = albumActionContext({ canCare: false, playerInstalled: true, maintenance: false });

const html = (p: Partial<AlbumActionStripProps>) =>
  renderToStaticMarkup(<AlbumActionStrip layout="phone" context={owner} play={{ mode: 'play' }} menu={menu} {...p} />);

/** each slot's markup, in order */
const slots = (markup: string) => [...markup.matchAll(/<div[^>]*data-slot="([a-z]+)"[^>]*>/g)].map((m) => ({ id: m[1]!, tag: m[0] }));

describe('AlbumActionStrip', () => {
  it('owner today on a phone: five slots, Play and ⋯ are keys, the rest is space', () => {
    const s = slots(html({}));
    expect(s.map((x) => x.id)).toEqual(['like', 'playlist', 'play', 'radio', 'more']);
    for (const x of s.filter((x) => ['like', 'playlist', 'radio'].includes(x.id))) {
      expect(x.tag).toContain('aria-hidden="true"');
      expect(x.tag).toContain('data-empty=""');
    }
  });

  it('empty slots hold nothing focusable: only Play and ⋯ are buttons', () => {
    const markup = html({});
    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="More for this album"');
    for (const m of markup.matchAll(/<div[^>]*data-empty=""[^>]*>(.*?)<\/div>/g)) expect(m[1]).toBe('');
    const css = readFileSync(new URL('./AlbumActionStrip.module.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.space \{[^}]*visibility: hidden;[^}]*pointer-events: none;/);
  });

  it('listener: Play only, no ⋯', () => {
    const markup = html({ context: listener, menu: null });
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).not.toContain('More for this album');
  });

  it('no player: the owner keeps ⋯ alone; a listener gets no strip at all', () => {
    const ctx = albumActionContext({ canCare: true, playerInstalled: false, maintenance: false });
    const markup = html({ context: ctx, play: null });
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).not.toContain('data-album-play');
    const none = albumActionContext({ canCare: false, playerInstalled: false, maintenance: false });
    expect(html({ context: none, play: null, menu: null })).toBe('');
  });

  it('desktop: Play first, 200px, then four empty slots and ⋯', () => {
    const markup = html({ layout: 'desk' });
    expect(slots(markup).map((x) => x.id)).toEqual(['play', 'like', 'playlist', 'share', 'radio', 'more']);
    expect(markup).toContain('grid-template-columns:200px 58px 58px 58px 58px 58px');
  });

  it('waiting for the player\'s first scan: Play disabled showing the progress, described by the note', () => {
    const note = 'On the player after its first scan (34 %)';
    const markup = html({ play: { mode: 'play', disabled: true, waitText: '34 %', note } });
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Play"[^>]*aria-describedby="album-play-note"/);
    expect(markup).toContain('34 %</span>');
    expect(markup).toContain(`<p id="${PLAY_NOTE_ID}"`);
    expect(markup).toContain(note);
  });

  it('playing: Pause with the playing bars; loading: busy with a spinner', () => {
    const playing = html({ play: { mode: 'pause' } });
    expect(playing).toContain('<span>Pause</span>');
    expect(playing).toMatch(/<span class="[^"]*bars[^"]*" aria-hidden="true">/);
    expect(html({ play: { mode: 'play', loading: true } })).toContain('aria-busy="true"');
  });

  it('the strip does not shift between states: same slots, same columns', () => {
    const shape = (m: string) => [slots(m).map((x) => x.id).join(), m.match(/grid-template-columns:[^"]*/)?.[0]];
    const ready = shape(html({}));
    expect(shape(html({ play: { mode: 'pause' } }))).toEqual(ready);
    expect(shape(html({ play: { mode: 'play', disabled: true, waitText: '34 %', note: 'x' } }))).toEqual(ready);
    expect(shape(html({ play: { mode: 'play', loading: true } }))).toEqual(ready);
  });
});

describe('the docked header ▶ (rule 8 amended)', () => {
  const props = (over: Partial<AlbumFlowHeaderProps> = {}): AlbumFlowHeaderProps => ({
    docked: true, artist: 'Y&T', title: 'Live at the Mystic', glide: { x: 0, y: 0 }, backLabel: 'Back to Albums',
    onBack: vi.fn(), onTop: vi.fn(), maintenance: false, onToggleMaintenance: vi.fn(), ...over,
  });
  const labels = (m: string) => [...m.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((x) => x[1]);

  it('four keys once the strip is under the header: back | title | ▶ | Maintenance', () => {
    const m = renderToStaticMarkup(<AlbumFlowHeader {...props({ play: { mode: 'play' }, playDocked: true })} />);
    expect(labels(m)).toEqual(['Back to Albums', 'Back to the top of the album', 'Play', 'Turn on Maintenance']);
    expect(m).toContain('data-play-docked=""');
    expect(m).toMatch(/data-header-play="" aria-label="Play" title="Play" tabindex="0"/);
  });

  it('before then ▶ is out of reach; without a player there are the approved three keys', () => {
    const m = renderToStaticMarkup(<AlbumFlowHeader {...props({ play: { mode: 'play' }, playDocked: false })} />);
    expect(m).toMatch(/data-header-play="" aria-label="Play" title="Play" tabindex="-1" aria-hidden="true"/);
    expect(labels(renderToStaticMarkup(<AlbumFlowHeader {...props({ play: null, playDocked: true })} />))).toHaveLength(3);
  });

  it('follows the strip: disabled while the player waits, Pause while playing', () => {
    const wait = renderToStaticMarkup(<AlbumFlowHeader {...props({ play: { mode: 'play', disabled: true, note: 'x', waitText: '34 %' }, playDocked: true, playNoteId: PLAY_NOTE_ID })} />);
    expect(wait).toMatch(/data-header-play=""[^>]*disabled=""[^>]*aria-describedby="album-play-note"/);
    const playing = renderToStaticMarkup(<AlbumFlowHeader {...props({ play: { mode: 'pause' }, playDocked: true })} />);
    expect(labels(playing)[2]).toBe('Pause');
  });
});
