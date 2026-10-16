import { describe, expect, it, vi } from 'vitest';
import { SHIPPED, SLOTS, actionAvailable, albumActionContext, albumMenu, albumMenuItems, playLabel, rowSlots, type AlbumActionId, type AlbumMenuInput } from './albumActions';

const ids = (slots: ReturnType<typeof rowSlots>) => slots?.map((s) => (s.filled ? s.id : `(${s.id})`)) ?? null;

describe('the action row: Shuffle | Play | ⋮', () => {
  it('reads the slot list, Play in the middle', () => {
    expect(SLOTS).toEqual(['shuffle', 'play', 'more']);
    expect(SLOTS.indexOf('play')).toBe((SLOTS.length - 1) / 2);
  });

  it('with a player every slot has its icon', () => {
    expect(ids(rowSlots(SLOTS, albumActionContext({ playerInstalled: true })))).toEqual(['shuffle', 'play', 'more']);
  });

  it('no player, or no player.use: no Play and no Shuffle, so no row (⋮ is in the header)', () => {
    expect(rowSlots(SLOTS, albumActionContext({ playerInstalled: false }))).toBeNull();
    expect(rowSlots(SLOTS, albumActionContext({ playerInstalled: true, canPlay: false }))).toBeNull();
  });

  it('planned actions are not shipped: no dead buttons, their slots draw nothing', () => {
    for (const id of ['like', 'playlist', 'share', 'radio'] as AlbumActionId[]) expect(SHIPPED.has(id)).toBe(false);
    const ctx = albumActionContext({ playerInstalled: true });
    const planned: AlbumActionId[] = ['like', 'shuffle', 'play', 'more', 'share'];
    expect(ids(rowSlots(planned, ctx))).toEqual(['(like)', 'shuffle', 'play', 'more', '(share)']);
    // shipped later, they slot in symmetrically and Play stays in the middle
    const later = rowSlots(planned, { ...ctx, shipped: new Set<AlbumActionId>([...SHIPPED, 'like', 'share']) });
    expect(ids(later)).toEqual(['like', 'shuffle', 'play', 'more', 'share']);
  });

  it('radio and add to playlist need a player; like and share do not', () => {
    const shipped = new Set<AlbumActionId>(['like', 'share', 'radio', 'playlist']);
    const without = { player: false, menu: true, shipped };
    expect(actionAvailable('radio', without)).toBe(false);
    expect(actionAvailable('playlist', without)).toBe(false);
    expect(actionAvailable('like', without)).toBe(true);
    expect(actionAvailable('share', without)).toBe(true);
  });

  it('Play says what it does', () => {
    expect(playLabel('play')).toBe('Play');
    expect(playLabel('pause')).toBe('Pause');
    expect(playLabel('resume')).toBe('Resume');
  });
});

describe('the ⋮ menu by role', () => {
  const base = (over: Partial<AlbumMenuInput> = {}): AlbumMenuInput => ({
    canCare: true,
    maintenance: false,
    shuffle: vi.fn(),
    artists: [{ id: 'a1', name: 'Y&T', go: vi.fn() }],
    ownPhysical: { pending: false, onSelect: vi.fn() },
    onInfo: vi.fn(),
    tools: [{ key: 'reidentify', label: 'Re-identify', icon: 'tool', onSelect: vi.fn() }],
    onToggleMaintenance: vi.fn(),
    ...over,
  });
  const keys = (a: { key: string }[]) => a.map((x) => x.key);

  it('owner or editor: Shuffle, the artist and the physical copy as tiles; Album info; the Maintenance switch', () => {
    const m = albumMenu(base());
    expect(keys(m.tiles)).toEqual(['shuffle', 'artist-a1', 'own']);
    expect(m.tiles.map((t) => t.label)).toEqual(['Shuffle', 'Go to Y&T', 'I own this on vinyl/CD']);
    expect(keys(m.rows)).toEqual(['info']);
    expect(m.tools).toEqual([]);
    expect(m.maintenance?.on).toBe(false);
  });

  it('listener: only listener-safe items, no copy, no tools, no Maintenance', () => {
    const m = albumMenu(base({ canCare: false, maintenance: true }));
    expect(keys(m.tiles)).toEqual(['shuffle', 'artist-a1']);
    expect(keys(m.rows)).toEqual(['info']);
    expect(m.tools).toEqual([]);
    expect(m.maintenance).toBeNull();
    expect(keys(albumMenuItems(m))).toEqual(['shuffle', 'artist-a1', 'info']);
  });

  it('Maintenance on: its tools join, and the switch turns it off', () => {
    const input = base({ maintenance: true });
    const m = albumMenu(input);
    expect(keys(m.tools)).toEqual(['reidentify']);
    expect(m.maintenance?.on).toBe(true);
    const items = albumMenuItems(m);
    const mode = items.find((i) => i.key === 'mode');
    expect(mode?.label).toBe('Turn off Maintenance');
    expect(items.at(-1)?.key).toBe('mode');
    expect(items.find((i) => i.key === 'reidentify')?.separated).toBe(true);
    mode?.onSelect?.();
    expect(input.onToggleMaintenance).toHaveBeenCalledTimes(1);
  });

  it('Maintenance off: the switch turns it on', () => {
    const items = albumMenuItems(albumMenu(base()));
    expect(items.find((i) => i.key === 'mode')?.label).toBe('Turn on Maintenance');
  });

  it('no Shuffle while the player waits; no copy once owned; several artists are rows', () => {
    const m = albumMenu(base({
      shuffle: null,
      ownPhysical: null,
      artists: [{ id: 'a1', name: 'Ozzy', go: vi.fn() }, { id: 'a2', name: 'Randy Rhoads', go: vi.fn() }],
    }));
    expect(m.tiles).toEqual([]);
    expect(keys(m.rows)).toEqual(['info', 'artist-a1', 'artist-a2']);
  });

  it('adding the copy: the tile says so and waits', () => {
    const own = albumMenu(base({ ownPhysical: { pending: true, onSelect: vi.fn() } })).tiles.find((t) => t.key === 'own');
    expect(own?.label).toBe('Adding…');
    expect(own?.disabled).toBe(true);
  });

  it('every item does something (no dead buttons)', () => {
    const m = albumMenu(base({ maintenance: true }));
    for (const a of [...m.tiles, ...m.rows, ...m.tools]) expect(typeof a.onSelect).toBe('function');
    for (const i of albumMenuItems(m)) expect(typeof i.onSelect).toBe('function');
  });
});
