import { describe, expect, it } from 'vitest';
import { SLOTS, actionAvailable, albumActionContext, stripColumns, stripSlots, type AlbumActionId } from './albumActions';

const filledIds = (list: readonly AlbumActionId[], ctx: Parameters<typeof stripSlots>[1]) =>
  (stripSlots(list, ctx) ?? []).filter((s) => s.filled).map((s) => s.id);

/** Roles as the page sees them: owner and editor can care for the library, a listener cannot. */
const ROLES = { owner: true, editor: true, listener: false } as const;

describe('album action strip: slot lists', () => {
  it('phone: like, playlist, PLAY in the centre, radio, ⋯ pinned last', () => {
    expect(SLOTS.phone).toEqual(['like', 'playlist', 'play', 'radio', 'more']);
    expect(SLOTS.phone.indexOf('play')).toBe((SLOTS.phone.length - 1) / 2);
  });

  it('desktop: Play first, every action, ⋯ pinned last', () => {
    expect(SLOTS.desk).toEqual(['play', 'like', 'playlist', 'share', 'radio', 'more']);
  });

  it('Play is the wide key: 1fr in the phone centre, 200px on a desktop; other slots fixed', () => {
    expect(stripColumns(SLOTS.phone, 'phone')).toBe('52px 52px minmax(0, 1fr) 52px 52px');
    expect(stripColumns(SLOTS.desk, 'desk')).toBe('200px 58px 58px 58px 58px 58px');
  });
});

describe('album action strip: availability by role and player', () => {
  for (const [role, canCare] of Object.entries(ROLES)) {
    it(`${role} with a player: Play${canCare ? ' and ⋯' : ' only'}`, () => {
      const ctx = albumActionContext({ canCare, playerInstalled: true, maintenance: false });
      expect(filledIds(SLOTS.phone, ctx)).toEqual(canCare ? ['play', 'more'] : ['play']);
      expect(filledIds(SLOTS.desk, ctx)).toEqual(canCare ? ['play', 'more'] : ['play']);
    });

    it(`${role} without a player: ${canCare ? 'only ⋯' : 'no strip at all'}`, () => {
      const ctx = albumActionContext({ canCare, playerInstalled: false, maintenance: false });
      if (canCare) expect(filledIds(SLOTS.phone, ctx)).toEqual(['more']);
      else expect(stripSlots(SLOTS.phone, ctx)).toBeNull();
    });
  }

  it('like, playlist, share and radio do not exist yet: their slots are empty, never dead keys', () => {
    const ctx = albumActionContext({ canCare: true, playerInstalled: true, maintenance: false });
    for (const id of ['like', 'playlist', 'share', 'radio'] as const) expect(actionAvailable(id, ctx)).toBe(false);
    const cells = stripSlots(SLOTS.desk, ctx)!;
    expect(cells.map((c) => c.id)).toEqual(SLOTS.desk);
    expect(cells.filter((c) => !c.filled).map((c) => c.id)).toEqual(['like', 'playlist', 'share', 'radio']);
  });

  it('a player that has not scanned the album keeps the Play slot (the key shows disabled)', () => {
    // scan state disables the key, not the slot: the strip does not shift while it waits
    const ctx = albumActionContext({ canCare: false, playerInstalled: true, maintenance: false });
    expect(actionAvailable('play', ctx)).toBe(true);
  });

  it('in Maintenance the menu moves to the state line: the ⋯ slot is empty', () => {
    const ctx = albumActionContext({ canCare: true, playerInstalled: true, maintenance: true });
    expect(filledIds(SLOTS.phone, ctx)).toEqual(['play']);
    expect(stripSlots(SLOTS.phone, albumActionContext({ canCare: true, playerInstalled: false, maintenance: true }))).toBeNull();
  });

  it('an empty ⋯ menu leaves its slot empty', () => {
    expect(actionAvailable('more', albumActionContext({ canCare: true, playerInstalled: true, maintenance: false, menuItems: 0 }))).toBe(false);
  });

  it('once the planned actions ship they fill their slots; playlist and radio need a player', () => {
    const shipped = new Set<AlbumActionId>(['play', 'more', 'like', 'playlist', 'share', 'radio']);
    expect(filledIds(SLOTS.phone, { player: true, menu: true, shipped })).toEqual(['like', 'playlist', 'play', 'radio', 'more']);
    expect(filledIds(SLOTS.desk, { player: false, menu: true, shipped })).toEqual(['like', 'share', 'more']);
  });

  it('a person\'s own list only rewrites the slots', () => {
    const own: AlbumActionId[] = ['radio', 'like', 'play', 'playlist', 'more'];
    expect(stripSlots(own, { player: true, menu: true })!.map((c) => c.id)).toEqual(own);
  });
});

describe('album action strip: runs of touching keys', () => {
  it('each run of keys gets its own rounded ends; empty slots end a run', () => {
    const cells = stripSlots(SLOTS.phone, { player: true, menu: true })!;
    const play = cells.find((c) => c.id === 'play')!;
    const more = cells.find((c) => c.id === 'more')!;
    expect([play.runStart, play.runEnd]).toEqual([true, true]);
    expect([more.runStart, more.runEnd]).toEqual([true, true]);
    const all = stripSlots(SLOTS.phone, { player: true, menu: true, shipped: new Set(SLOTS.phone) })!;
    expect(all.map((c) => [c.runStart, c.runEnd])).toEqual([[true, false], [false, false], [false, false], [false, false], [false, true]]);
  });
});
