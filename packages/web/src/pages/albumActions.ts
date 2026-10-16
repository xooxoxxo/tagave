/**
 * The album page's action strip (vault spec "tagave - Album Page Flow",
 * changes 2026-10-16, direction B "Transport", empty slots = Space).
 *
 * The strip is drawn from a slot list and nothing else: a later per-person
 * setting only rewrites the list (reorder, swap an action into a slot) and
 * the layout follows. Every slot keeps its width whether or not a key sits in
 * it, so Play never moves as actions ship. ⋯ is pinned to the last slot and
 * is not part of the customisable set, so it can never be configured away.
 */

export type AlbumActionId = 'play' | 'like' | 'playlist' | 'share' | 'radio' | 'more';
export type StripLayout = 'phone' | 'desk';

/**
 * Phone: Play is the wide centre key, two slots each side, ⋯ in the outer
 * right one; Share (which opens a sheet anyway) lives in ⋯ on a phone.
 * Desktop: a wide text Play first, then every action.
 */
export const SLOTS: Readonly<Record<StripLayout, readonly AlbumActionId[]>> = {
  phone: ['like', 'playlist', 'play', 'radio', 'more'],
  desk: ['play', 'like', 'playlist', 'share', 'radio', 'more'],
};

/**
 * Actions that exist in the app. Like, add to playlist, share and radio are
 * planned: their slots are reserved but stay empty (never a disabled
 * "coming soon" key). Add one here when it ships.
 */
export const SHIPPED: ReadonlySet<AlbumActionId> = new Set<AlbumActionId>(['play', 'more']);

/** What this person can do on this album right now. */
export interface AlbumActionContext {
  /** a player module is installed (Play shows, disabled while it cannot play) */
  player: boolean;
  /** the ⋯ menu has something in it for this role here */
  menu: boolean;
  /** the actions that exist (tests and stories can pass the planned set) */
  shipped?: ReadonlySet<AlbumActionId>;
}

/**
 * The context from role and capabilities. The ⋯ menu outside Maintenance
 * holds "I own this on vinyl/CD" and the Maintenance switch, both library
 * care: an owner or editor has it, a listener does not. In Maintenance the
 * menu moves to the state line, so the strip's ⋯ slot is empty.
 */
export function albumActionContext({ canCare, playerInstalled, maintenance, menuItems }: {
  canCare: boolean;
  playerInstalled: boolean;
  maintenance: boolean;
  /** how many items the ⋯ menu would show (defaults to what library care gives) */
  menuItems?: number;
}): AlbumActionContext {
  const items = menuItems ?? (canCare ? 1 : 0);
  return { player: playerInstalled, menu: !maintenance && items > 0 };
}

/** Whether an action has a key in its slot. */
export function actionAvailable(id: AlbumActionId, ctx: AlbumActionContext): boolean {
  const shipped = ctx.shipped ?? SHIPPED;
  if (!shipped.has(id)) return false;
  switch (id) {
    case 'play': return ctx.player;
    // they start or add to playback: only with a player
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

/** The strip's slots, or null when no slot holds a key (then there is no strip at all). */
export function stripSlots(list: readonly AlbumActionId[], ctx: AlbumActionContext): StripSlot[] | null {
  const filled = list.map((id) => actionAvailable(id, ctx));
  if (!filled.some(Boolean)) return null;
  return list.map((id, i) => ({
    id,
    filled: filled[i]!,
    runStart: filled[i]! && !filled[i - 1],
    runEnd: filled[i]! && !filled[i + 1],
  }));
}

/** The grid columns: Play wide (the phone's centre key fills what is left), every other slot fixed. */
export function stripColumns(list: readonly AlbumActionId[], layout: StripLayout): string {
  return list.map((id) => (id === 'play' ? (layout === 'desk' ? '200px' : 'minmax(0, 1fr)') : layout === 'desk' ? '58px' : '52px')).join(' ');
}

/** Play's state, shared by the strip and the docked header key. */
export interface AlbumPlayState {
  /** what Play does now: start the album, pause it, or carry on */
  mode: 'play' | 'pause' | 'resume';
  /** the album's queue is on its way */
  loading?: boolean;
  /** Play has to wait (the note says why) */
  disabled?: boolean;
  /** the key's words while it waits, e.g. the player's first-scan progress "34 %" */
  waitText?: string | null;
  /** why Play waits: "On the player after its first scan (34 %)" */
  note?: string | null;
  onPlay?: () => void;
  onToggle?: () => void;
}
