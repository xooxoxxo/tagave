import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AlbumActionRow, PLAY_NOTE_ID, PlayButton } from './AlbumActionRow';
import { AlbumActionsBody, AlbumSummaryHead, type AlbumSummary } from './AlbumMenu';
import { albumActionContext, albumMenu, type AlbumMenuInput, type AlbumPlayState } from './albumActions';

const noop = () => undefined;
const play = (over: Partial<AlbumPlayState> = {}): AlbumPlayState => ({ mode: 'play', onPlay: noop, onToggle: noop, onShuffle: noop, ...over });
const more = <button type="button" aria-label="More for this album" data-more="" />;
const row = (p: AlbumPlayState | null, playerInstalled = true) =>
  renderToStaticMarkup(<AlbumActionRow context={albumActionContext({ playerInstalled })} play={p} more={more} />);
const buttonsOf = (html: string) => [...html.matchAll(/<button[^>]*aria-label="([^"]+)"[^>]*>/g)].map((m) => m[1]);

describe('the action row', () => {
  it('Shuffle | Play | ⋮, Play in the middle', () => {
    expect(buttonsOf(row(play()))).toEqual(['Shuffle', 'Play', 'More for this album']);
  });

  it('Play is the one filled control: icon only, its word for screen readers', () => {
    const html = renderToStaticMarkup(<PlayButton play={play()} />);
    expect(html).toContain('aria-label="Play"');
    expect(html).toContain('<svg');
    expect(html.replace(/<[^>]+>/g, '')).toBe('');
  });

  it('Play, Pause and Resume', () => {
    expect(renderToStaticMarkup(<PlayButton play={play({ mode: 'pause' })} />)).toContain('aria-label="Pause"');
    expect(renderToStaticMarkup(<PlayButton play={play({ mode: 'resume' })} />)).toContain('aria-label="Resume"');
  });

  it('while the player has not reached the album: Play and Shuffle wait, one note says why, no percentage', () => {
    const note = 'On the player after its first scan';
    const html = row(play({ disabled: true, note }));
    expect(html).toMatch(/<button[^>]*aria-label="Play"[^>]*disabled=""/);
    expect(html).toMatch(/<button(?=[^>]*aria-label="Shuffle")(?=[^>]*disabled="")[^>]*>/);
    expect(html).toContain(`id="${PLAY_NOTE_ID}"`);
    expect(html).toContain(`aria-describedby="${PLAY_NOTE_ID}"`);
    expect(html).toContain(note);
    expect(html).not.toMatch(/\d\s?%/);
  });

  it('loading: a spinner, busy, not a second start', () => {
    const html = renderToStaticMarkup(<PlayButton play={play({ loading: true })} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('<svg');
  });

  it('no player: no Play, no Shuffle, no row', () => {
    expect(row(null)).toBe('');
    expect(row(play(), false)).toBe('');
  });

  it('Play is round and filled; the side icons are embossed, not circles', () => {
    const css = readFileSync(new URL('./AlbumActionRow.module.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.play \{[^}]*border-radius: 50%;[^}]*background: var\(--dew\);/);
    expect(row(play())).toMatch(/aria-label="Shuffle"[^>]*class="[^"]*emboss/);
  });
});

describe('the ⋮ drawer by role', () => {
  const summary: AlbumSummary = { coverUrl: null, title: 'Live at the Mystic', artist: 'Y&T', kicker: ['Hard Rock', '2012'], format: 'MP3 320 kbps' };
  const input = (over: Partial<AlbumMenuInput> = {}): AlbumMenuInput => ({
    canCare: true, maintenance: false, shuffle: vi.fn(), artists: [{ id: 'a1', name: 'Y&T', go: vi.fn() }],
    ownPhysical: { pending: false, onSelect: vi.fn() }, onInfo: vi.fn(),
    tools: [{ key: 'reidentify', label: 'Re-identify', icon: 'tool', onSelect: vi.fn() }], onToggleMaintenance: vi.fn(), ...over,
  });
  const body = (over: Partial<AlbumMenuInput> = {}) => renderToStaticMarkup(<AlbumActionsBody summary={summary} model={albumMenu(input(over))} onClose={noop} />);

  it('the summary: thumb, title, artist, Genre · Year and the format', () => {
    const html = renderToStaticMarkup(<AlbumSummaryHead summary={summary} />);
    for (const s of ['Live at the Mystic', 'Y&amp;T', 'Hard Rock · 2012', 'MP3 320 kbps']) expect(html).toContain(s);
  });

  it('owner: tiles, Album info, and the Maintenance switch at the bottom', () => {
    const html = body();
    expect([...html.matchAll(/data-menu-tile="([^"]+)"/g)].map((m) => m[1])).toEqual(['shuffle', 'artist-a1', 'own']);
    expect([...html.matchAll(/data-menu-row="([^"]+)"/g)].map((m) => m[1])).toEqual(['info', 'mode']);
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="Maintenance"/);
    expect(html).not.toContain('Maintenance tools');
  });

  it('owner in Maintenance: the tools, and the switch says it is on', () => {
    const html = body({ maintenance: true });
    expect(html).toContain('Maintenance tools');
    expect(html).toContain('data-menu-row="reidentify"');
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="Maintenance"/);
  });

  it('listener: Shuffle, the artist and Album info only', () => {
    const html = body({ canCare: false, maintenance: true });
    expect([...html.matchAll(/data-menu-(?:tile|row)="([^"]+)"/g)].map((m) => m[1])).toEqual(['shuffle', 'artist-a1', 'info']);
    expect(html).not.toContain('Maintenance');
    expect(html).not.toContain('I own this');
  });

  it('picking closes the drawer first, then acts; the switch toggles Maintenance', () => {
    const order: string[] = [];
    const m = albumMenu(input({ onInfo: () => order.push('info'), onToggleMaintenance: () => order.push('toggle') }));
    const tree = AlbumActionsBody({ summary, model: m, onClose: () => order.push('close') });
    // walk the element tree for the buttons' click handlers
    const clicks: Array<() => void> = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object' || !('props' in n)) return;
      const el = n as { type: unknown; props: Record<string, unknown> };
      if (el.type === 'button' && (el.props['data-menu-row'] === 'info' || el.props['data-menu-row'] === 'mode')) clicks.push(el.props.onClick as () => void);
      walk(el.props.children);
    };
    walk(tree);
    clicks.forEach((c) => c());
    expect(order).toEqual(['close', 'info', 'close', 'toggle']);
  });
});
