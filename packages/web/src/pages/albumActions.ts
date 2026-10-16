/**
 * The album page's action strip (vault spec "tagave - Album Page Flow",
 * changes 2026-10-16, direction B "Transport").
 *
 * The strip is drawn from a slot list and nothing else: a later per-person
 * setting only rewrites the list (insert an action, reorder) and the layout
 * follows. Owner, 2026-10-16: Play is icon only and fills the room between
 * one key on each side, Shuffle on the left and ⋯ on the right, both as wide
 * as each other, so Play sits on the centre line and the strip is
 * symmetric. A new action is a new key in the list; Play gives up the width.
 */

export type AlbumActionId = 'shuffle' | 'play' | 'more' | 'like' | 'playlist' | 'share' | 'radio';
export type StripLayout = 'phone' | 'desk';

/** Phone and desktop alike: Shuffle | Play | ⋯ (⋯ stays last). */
export const SLOTS: Readonly<Record<StripLayout, readonly AlbumActionId[]>> = {
  phone: ['shuffle', 'play', 'more'],
  desk: ['shuffle', 'play', 'more'],
};

/**
 * Actions that exist in the app. Like, add to playlist, share and radio are
 * planned; they get keys in the list once they ship (never a disabled
 * "coming soon" key).
 */
export const SHIPPED: ReadonlySet<AlbumActionId> = new Set<AlbumActionId>(['shuffle', 'play', 'more']);

/** What this person can do on this album right now. */
export interface AlbumActionContext {
  /** a player module is installed and the role may use it (player.use): Play and Shuffle show */
  player: boolean;
  /** the ⋯ menu has something in it for this role here */
  menu: boolean;
  /** the actions that exist (tests and stories can pass the planned set) */
  shipped?: ReadonlySet<AlbumActionId>;
}

/**
 * The context from role and capabilities. Play and Shuffle need a player and
 * player.use (every role has it today). ⋯ shows when its menu has real items
 * for this role: the artist's page for everyone, the physical copy and the
 * Maintenance switch with library care. In Maintenance the menu moves to the
 * state line, so the strip's ⋯ slot is empty.
 */
export function albumActionContext({ canPlay = true, playerInstalled, maintenance, menuItems }: {
  /** the role's player.use */
  canPlay?: boolean;
  playerInstalled: boolean;
  maintenance: boolean;
  /** how many items the ⋯ menu shows */
  menuItems: number;
}): AlbumActionContext {
  return { player: playerInstalled && canPlay, menu: !maintenance && menuItems > 0 };
}

/** Whether an action has a key in its slot. */
export function actionAvailable(id: AlbumActionId, ctx: AlbumActionContext): boolean {
  const shipped = ctx.shipped ?? SHIPPED;
  if (!shipped.has(id)) return false;
  switch (id) {
    // they start or add to playback: only with a player
    case 'play':
    case 'shuffle':
    case 'playlist':
    case 'radio': return ctx.player;
    case 'like':
    case 'share': return true;
    case 'more': return ctx.menu;
  }
}

export interface StripSlot {
  id: AlbumActionId;
  /** a key sits here; otherwise the slot is space (no key drawn, not focusable) */
  filled: boolean;
  /** the outer corners of each unbroken run of keys are rounded */
  runStart: boolean;
  runEnd: boolean;
}

/**
 * The strip's slots, or null when no slot holds a key (then there is no
 * strip at all). With Play, an empty slot keeps its width (nothing drawn),
 * so Play stays on the centre line. Without Play (no player) only the keys
 * there are remain, packed together.
 */
export function stripSlots(list: readonly AlbumActionId[], ctx: AlbumActionContext): StripSlot[] | null {
  const all = list.map((id) => ({ id, filled: actionAvailable(id, ctx) }));
  if (!all.some((s) => s.filled)) return null;
  const kept = all.some((s) => s.id === 'play' && s.filled) ? all : all.filter((s) => s.filled);
  return kept.map((s, i) => ({
    ...s,
    runStart: s.filled && !kept[i - 1]?.filled,
    runEnd: s.filled && !kept[i + 1]?.filled,
  }));
}

/** The side keys' width (⋯'s), so the keys either side of Play match. */
export const SIDE_KEY: Readonly<Record<StripLayout, number>> = { phone: 56, desk: 58 };

/** The grid columns: Play wide (on a phone it fills what the side keys leave), every other key one side key wide. */
export function stripColumns(list: readonly AlbumActionId[], layout: StripLayout): string {
  return list.map((id) => (id === 'play' ? (layout === 'desk' ? '200px' : 'minmax(0, 1fr)') : `${SIDE_KEY[layout]}px`)).join(' ');
}

/** Play's state, shared by the strip and the docked header key. */
export interface AlbumPlayState {
  /** what Play does now: start the album, pause it, or carry on */
  mode: 'play' | 'pause' | 'resume';
  /** the album's queue is on its way */
  loading?: boolean;
  /** Play has to wait (the note says why) */
  disabled?: boolean;
  /** why Play waits: "On the player after its first scan" */
  note?: string | null;
  onPlay?: () => void;
  onToggle?: () => void;
  /** the album in a random order (Shuffle) */
  onShuffle?: () => void;
}

/** Play's word for screen readers and its tooltip (the key itself shows only the icon). */
export const playLabel = (mode: AlbumPlayState['mode']) => (mode === 'pause' ? 'Pause' : mode === 'resume' ? 'Resume' : 'Play');
