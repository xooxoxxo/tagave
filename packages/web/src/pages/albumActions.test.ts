import { describe, expect, it } from 'vitest';
import { SIDE_KEY, SLOTS, actionAvailable, albumActionContext, playLabel, stripColumns, stripSlots, type AlbumActionId } from './albumActions';

const filledIds = (list: readonly AlbumActionId[], ctx: Parameters<typeof stripSlots>[1]) =>
  (stripSlots(list, ctx) ?? []).filter((s) => s.filled).map((s) => s.id);

/**
 * What each role's ⋯ holds outside Maintenance (AlbumDetailPage): the
 * album's artists for everyone, the physical copy and the Maintenance switch
 * with library care.
 */
const MENU = { owner: 3, editor: 3, listener: 1 } as const;

describe('album action strip: slot lists', () => {
  it('Shuffle | Play | ⋯ on a phone and a desktop, Play in the middle, ⋯ last', () => {
    expect(SLOTS.phone).toEqual(['shuffle', 'play', 'more']);
    expect(SLOTS.desk).toEqual(['shuffle', 'play', 'more']);
  });

  it('the side keys are as wide as each other; Play fills the phone row, 200px on a desktop', () => {
    expect(stripColumns(SLOTS.phone, 'phone')).toBe(`${SIDE_KEY.phone}px minmax(0, 1fr) ${SIDE_KEY.phone}px`);
    expect(stripColumns(SLOTS.desk, 'desk')).toBe(`${SIDE_KEY.desk}px 200px ${SIDE_KEY.desk}px`);
  });

  it('a new action is a new key in the list: Play gives up the width', () => {
    const more: AlbumActionId[] = ['like', 'shuffle', 'play', 'radio', 'more'];
    expect(stripColumns(more, 'phone')).toBe('56px 56px minmax(0, 1fr) 56px 56px');
  });

  it('Play\'s word is for screen readers only', () => {
    expect([playLabel('play'), playLabel('pause'), playLabel('resume')]).toEqual(['Play', 'Pause', 'Resume']);
  });
});

describe('album action strip: availability by role and player', () => {
  for (const [role, items] of Object.entries(MENU)) {
    it(`${role} with a player: Shuffle, Play and ⋯ (the strip is symmetric)`, () => {
      const ctx = albumActionContext({ playerInstalled: true, maintenance: false, menuItems: items });
      expect(filledIds(SLOTS.phone, ctx)).toEqual(['shuffle', 'play', 'more']);
      expect(filledIds(SLOTS.desk, ctx)).toEqual(['shuffle', 'play', 'more']);
    });
  }

  it('without player.use there is no Play and no Shuffle', () => {
    const ctx = albumActionContext({ canPlay: false, playerInstalled: true, maintenance: false, menuItems: 1 });
    expect(filledIds(SLOTS.phone, ctx)).toEqual(['more']);
  });

  it('no player: the owner keeps ⋯ alone, packed (no empty slots); nothing to press, no strip', () => {
    const owner = stripSlots(SLOTS.phone, albumActionContext({ playerInstalled: false, maintenance: false, menuItems: MENU.owner }))!;
    expect(owner.map((s) => [s.id, s.filled])).toEqual([['more', true]]);
    expect(stripSlots(SLOTS.phone, albumActionContext({ playerInstalled: false, maintenance: false, menuItems: 0 }))).toBeNull();
  });

  it('a player that has not scanned the album keeps Play and Shuffle (the keys show disabled)', () => {
    const ctx = albumActionContext({ playerInstalled: true, maintenance: false, menuItems: 1 });
    expect(actionAvailable('play', ctx)).toBe(true);
    expect(actionAvailable('shuffle', ctx)).toBe(true);
  });

  it('an empty ⋯ (an album with no artist pages, for a listener) keeps its width: Play stays centred', () => {
    const cells = stripSlots(SLOTS.phone, albumActionContext({ playerInstalled: true, maintenance: false, menuItems: 0 }))!;
    expect(cells.map((c) => [c.id, c.filled])).toEqual([['shuffle', true], ['play', true], ['more', false]]);
  });

  it('in Maintenance the menu moves to the state line: the ⋯ slot is empty', () => {
    const ctx = albumActionContext({ playerInstalled: true, maintenance: true, menuItems: MENU.owner });
    expect(filledIds(SLOTS.phone, ctx)).toEqual(['shuffle', 'play']);
  });

  it('planned actions have no keys until they ship', () => {
    const ctx = albumActionContext({ playerInstalled: true, maintenance: false, menuItems: 1 });
    for (const id of ['like', 'playlist', 'share', 'radio'] as const) expect(actionAvailable(id, ctx)).toBe(false);
    const shipped = new Set<AlbumActionId>(['shuffle', 'play', 'more', 'radio']);
    expect(filledIds(['shuffle', 'play', 'radio', 'more'], { player: true, menu: true, shipped })).toEqual(['shuffle', 'play', 'radio', 'more']);
    expect(filledIds(['shuffle', 'play', 'radio', 'more'], { player: false, menu: true, shipped })).toEqual(['more']);
  });
});

describe('album action strip: touching keys', () => {
  it('one run with rounded outer ends; an empty side slot ends the run at Play', () => {
    const full = stripSlots(SLOTS.phone, { player: true, menu: true })!;
    expect(full.map((c) => [c.runStart, c.runEnd])).toEqual([[true, false], [false, false], [false, true]]);
    const noMenu = stripSlots(SLOTS.phone, { player: true, menu: false })!;
    expect(noMenu.map((c) => [c.runStart, c.runEnd])).toEqual([[true, false], [false, true], [false, false]]);
  });
});
