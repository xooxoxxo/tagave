import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AlbumActionStrip, PLAY_NOTE_ID, type AlbumActionStripProps } from './AlbumActionStrip';
import { AlbumFlowHeader, type AlbumFlowHeaderProps } from './AlbumFlowHeader';
import { albumActionContext } from './albumActions';

const menu = { label: 'More for this album', items: [{ key: 'artist-1', label: 'Go to Y&T', onSelect: vi.fn() }] };
const ctx = albumActionContext({ playerInstalled: true, maintenance: false, menuItems: 1 });

const html = (p: Partial<AlbumActionStripProps>) =>
  renderToStaticMarkup(<AlbumActionStrip layout="phone" context={ctx} play={{ mode: 'play' }} menu={menu} {...p} />);

/** each slot's markup, in order */
const slots = (markup: string) => [...markup.matchAll(/<div[^>]*data-slot="([a-z]+)"[^>]*>/g)].map((m) => ({ id: m[1]!, tag: m[0] }));
/** text outside tags (what a sighted person reads on the keys) */
const words = (markup: string) => markup.replace(/<[^>]*>/g, '').trim();

describe('AlbumActionStrip', () => {
  it('Shuffle | Play | ⋯, three buttons that touch, Play icon only', () => {
    const markup = html({});
    expect(slots(markup).map((x) => x.id)).toEqual(['shuffle', 'play', 'more']);
    expect(markup.match(/<button/g)).toHaveLength(3);
    expect(words(markup)).toBe('');
    expect(markup).toMatch(/data-album-play="" aria-label="Play" title="Play"/);
    expect(markup).toMatch(/data-album-shuffle="" aria-label="Shuffle"/);
    expect(markup).toContain('grid-template-columns:56px minmax(0, 1fr) 56px');
  });

  it('desktop: the same keys, Play 200px', () => {
    expect(html({ layout: 'desk' })).toContain('grid-template-columns:58px 200px 58px');
  });

  it('Play starts the album, Shuffle starts it in a random order', () => {
    const onPlay = vi.fn();
    const onShuffle = vi.fn();
    const el = AlbumActionStrip({ layout: 'phone', context: ctx, play: { mode: 'play', onPlay, onShuffle }, menu });
    const found: Array<{ props: Record<string, unknown> }> = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object' || !('props' in n)) return;
      const e = n as { type: unknown; props: Record<string, unknown> };
      if (typeof e.type === 'function' && e.type.name === 'PlayingBars') return;
      if (e.type === 'button') found.push(e);
      walk(e.props.children);
    };
    walk(el);
    const play = found.find((b) => 'data-album-play' in b.props)!;
    const shuffle = found.find((b) => 'data-album-shuffle' in b.props)!;
    (play.props.onClick as () => void)();
    (shuffle.props.onClick as () => void)();
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onShuffle).toHaveBeenCalledTimes(1);
  });

  it('an empty slot holds nothing focusable and keeps its width', () => {
    const markup = html({ menu: null });
    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(slots(markup).map((x) => x.id)).toEqual(['shuffle', 'play', 'more']);
    const empty = slots(markup).find((x) => x.id === 'more')!;
    expect(empty.tag).toContain('aria-hidden="true"');
    for (const m of markup.matchAll(/<div[^>]*data-empty=""[^>]*>(.*?)<\/div>/g)) expect(m[1]).toBe('');
    const css = readFileSync(new URL('./AlbumActionStrip.module.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.space \{[^}]*visibility: hidden;[^}]*pointer-events: none;/);
  });

  it('no player: ⋯ alone; nothing to press: no strip', () => {
    const noPlayer = albumActionContext({ playerInstalled: false, maintenance: false, menuItems: 1 });
    const markup = html({ context: noPlayer, play: null });
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).not.toContain('data-album-play');
    expect(markup).not.toContain('data-album-shuffle');
    expect(markup).toContain('grid-template-columns:56px');
    expect(html({ context: albumActionContext({ playerInstalled: false, maintenance: false, menuItems: 0 }), play: null, menu: null })).toBe('');
  });

  it('waiting for the player\'s first scan: Play and Shuffle disabled, icon only, no percentage; the note says why', () => {
    const note = 'On the player after its first scan';
    const markup = html({ play: { mode: 'play', disabled: true, note } });
    expect(markup).toMatch(/data-album-play="" aria-label="Play" title="Play" disabled=""[^>]*aria-describedby="album-play-note"/);
    expect(markup).toMatch(/data-album-shuffle=""[^>]*disabled=""/);
    expect(markup).not.toContain('%');
    expect(markup).toContain(`<p id="${PLAY_NOTE_ID}"`);
    expect(words(markup)).toBe(note);
  });

  it('playing: Pause (its word only for screen readers) with the playing bars; loading: busy with a spinner', () => {
    const playing = html({ play: { mode: 'pause' } });
    expect(playing).toMatch(/data-album-play="" aria-label="Pause"/);
    expect(playing).toMatch(/<span class="[^"]*bars[^"]*" aria-hidden="true">/);
    expect(words(playing)).toBe('');
    expect(html({ play: { mode: 'resume' } })).toMatch(/aria-label="Resume"/);
    expect(html({ play: { mode: 'play', loading: true } })).toContain('aria-busy="true"');
  });

  it('the strip does not shift between states: same slots, same columns', () => {
    const shape = (m: string) => [slots(m).map((x) => x.id).join(), m.match(/grid-template-columns:[^"]*/)?.[0]];
    const ready = shape(html({}));
    expect(shape(html({ play: { mode: 'pause' } }))).toEqual(ready);
    expect(shape(html({ play: { mode: 'play', disabled: true, note: 'x' } }))).toEqual(ready);
    expect(shape(html({ play: { mode: 'play', loading: true } }))).toEqual(ready);
  });
});

describe('the docked header ▶ (rule 8 amended)', () => {
  const props = (over: Partial<AlbumFlowHeaderProps> = {}): AlbumFlowHeaderProps => ({
    docked: true, artist: 'Y&T', title: 'Live at the Mystic', glide: { x: 0, y: 0 }, backLabel: 'Back to Albums',
    onBack: vi.fn(), onTop: vi.fn(), maintenance: false, onToggleMaintenance: vi.fn(), ...over,
  });
  const labels = (m: string) => [...m.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((x) => x[1]);

  it('four keys once the strip is under the header: back | title | ▶ | Maintenance; ▶ icon only', () => {
    const m = renderToStaticMarkup(<AlbumFlowHeader {...props({ play: { mode: 'play' }, playDocked: true })} />);
    expect(labels(m)).toEqual(['Back to Albums', 'Back to the top of the album', 'Play', 'Turn on Maintenance']);
    expect(m).toContain('data-play-docked=""');
    expect(m).toMatch(/data-header-play="" aria-label="Play" title="Play" tabindex="0"/);
    const key = m.match(/<button[^>]*data-header-play[^>]*>(.*?)<\/button>/)![1]!;
    expect(words(key)).toBe('');
  });

  it('before then ▶ is out of reach; without a player there are the approved three keys', () => {
    const m = renderToStaticMarkup(<AlbumFlowHeader {...props({ play: { mode: 'play' }, playDocked: false })} />);
    expect(m).toMatch(/data-header-play="" aria-label="Play" title="Play" tabindex="-1" aria-hidden="true"/);
    expect(labels(renderToStaticMarkup(<AlbumFlowHeader {...props({ play: null, playDocked: true })} />))).toHaveLength(3);
  });

  it('follows the strip: disabled while the player waits, Pause while playing', () => {
    const wait = renderToStaticMarkup(<AlbumFlowHeader {...props({ play: { mode: 'play', disabled: true, note: 'x' }, playDocked: true, playNoteId: PLAY_NOTE_ID })} />);
    expect(wait).toMatch(/data-header-play=""[^>]*disabled=""[^>]*aria-describedby="album-play-note"/);
    const playing = renderToStaticMarkup(<AlbumFlowHeader {...props({ play: { mode: 'pause' }, playDocked: true })} />);
    expect(labels(playing)[2]).toBe('Pause');
  });

  it('the docked ▶ is the same 64px key on a desktop', () => {
    const css = readFileSync(new URL('./AlbumFlowHeader.module.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/\.playKey \{ width: 132px/);
    expect(css).toMatch(/\.playKey \{[^}]*width: 64px;/);
  });
});
