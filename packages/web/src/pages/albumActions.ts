/**
 * The album page's actions (vault spec "tagave - Album Page Flow", changes
 * 2026-10-16 evening: conventions, Qobuz-like).
 *
 * Two places hold them:
 * - the action row under the album's details: raised (embossed) icons, Play
 *   the largest, read from a slot list (SLOTS). A later per-person setting
 *   only rewrites the list and the row follows; an action gets an icon once
 *   it ships, never a disabled "coming soon" icon.
 * - the one ⋮, in the header (a bottom drawer on a phone, a dropdown on a
 *   desktop): quick tiles, a list of rows, the Maintenance tools while
 *   Maintenance is on, and the Maintenance switch for library care
 *   (albumMenu). Owner, 2026-10-17: "only single ... is enough".
 *
 * Play never docks into the header.
 */
import type { ListenLinkView } from '@tagave/shared';
import type { MenuItem } from '../components/ui';

export type AlbumActionId = 'shuffle' | 'play' | 'like' | 'playlist' | 'share' | 'radio';

/**
 * The action row: Shuffle | Play | (like). Like is planned, so its slot is
 * space: nothing drawn, but it keeps Play on the row's centre line on a
 * phone until an action ships into it.
 */
export const SLOTS: readonly AlbumActionId[] = ['shuffle', 'play', 'like'];

/**
 * Actions that exist in the app. Like, add to playlist, share and radio are
 * planned; they get an icon in their slot once they ship.
 */
export const SHIPPED: ReadonlySet<AlbumActionId> = new Set<AlbumActionId>(['shuffle', 'play']);

/** What this person can do on this album right now. */
export interface AlbumActionContext {
  /** a player module is installed and the role may use it (player.use): Play and Shuffle show */
  player: boolean;
  /** the actions that exist (tests and stories can pass the planned set) */
  shipped?: ReadonlySet<AlbumActionId>;
}

/** The context from role and capabilities. Play and Shuffle need a player and player.use (every role has it today). */
export function albumActionContext({ canPlay = true, playerInstalled }: { canPlay?: boolean; playerInstalled: boolean }): AlbumActionContext {
  return { player: playerInstalled && canPlay };
}

/** Whether an action has an icon in its slot. */
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
  }
}

export interface RowSlot {
  id: AlbumActionId;
  /** an icon sits here; otherwise the slot keeps its width and draws nothing (Play stays centred) */
  filled: boolean;
}

/** The action row's slots, or null when there is no Play (no player: no row). */
export function rowSlots(list: readonly AlbumActionId[], ctx: AlbumActionContext): RowSlot[] | null {
  const all = list.map((id) => ({ id, filled: actionAvailable(id, ctx) }));
  return all.some((s) => s.id === 'play' && s.filled) ? all : null;
}

/** Play's state. */
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

/** Play's word for screen readers and its tooltip (the button itself shows only the icon). */
export const playLabel = (mode: AlbumPlayState['mode']) => (mode === 'pause' ? 'Pause' : mode === 'resume' ? 'Resume' : 'Play');

/* ---------------- the ⋮ menu ---------------- */

export type AlbumMenuIcon = 'shuffle' | 'artist' | 'disc' | 'info' | 'tool' | 'maintenance' | 'next' | 'queue' | 'playlist';

export interface AlbumMenuAction {
  key: string;
  label: string;
  /** one quiet line under the label */
  hint?: string | undefined;
  icon: AlbumMenuIcon;
  disabled?: boolean | undefined;
  /** a hairline above it (a new group of tools) */
  separated?: boolean | undefined;
  onSelect: () => void;
}

export interface AlbumMenuModel {
  /** large square quick actions at the top of the drawer */
  tiles: AlbumMenuAction[];
  /** icon + label rows */
  rows: AlbumMenuAction[];
  /** the Maintenance tools: only with library care, only while Maintenance is on */
  tools: AlbumMenuAction[];
  /** the Maintenance switch, for library care only */
  maintenance: { on: boolean; onToggle: () => void } | null;
  /** Listen elsewhere: the person's platforms for this album (only when there are any) */
  listen?: ListenLinkView[];
}

export interface AlbumMenuInput {
  /** library.edit: owners and editors */
  canCare: boolean;
  maintenance: boolean;
  /** Shuffle, when it can play now (a player, and the album on it) */
  shuffle?: (() => void) | null | undefined;
  artists: ReadonlyArray<{ id: string; name: string; go: () => void }>;
  /** "I own this on vinyl/CD": the album can be added to the physical collection and is not in it yet */
  ownPhysical?: { pending: boolean; onSelect: () => void } | null | undefined;
  /** the album info drawer (About, reviews) */
  onInfo: () => void;
  tools?: readonly AlbumMenuAction[] | undefined;
  onToggleMaintenance: () => void;
  /** Listen elsewhere (the listen-links module): links, in the person's order */
  listen?: readonly ListenLinkView[] | undefined;
  /** Play next / Add to queue (a player that can play the album now) */
  queue?: { next: () => void; end: () => void } | null | undefined;
  /** Add to playlist… (the playlists module) */
  addToPlaylist?: (() => void) | null | undefined;
}

/**
 * What the ⋮ menu holds for this person. Only real actions: a listener gets
 * Shuffle, the artist and Album info; library care adds the physical copy,
 * the Maintenance switch and, while Maintenance is on, its tools. One artist
 * is a tile; several are rows, one each.
 */
export function albumMenu(i: AlbumMenuInput): AlbumMenuModel {
  const artist = (a: AlbumMenuInput['artists'][number]): AlbumMenuAction => ({ key: `artist-${a.id}`, label: `Go to ${a.name}`, icon: 'artist', onSelect: a.go });
  const one = i.artists.length === 1 ? i.artists[0]! : null;
  const tiles: AlbumMenuAction[] = [
    ...(i.shuffle ? [{ key: 'shuffle', label: 'Shuffle', icon: 'shuffle' as const, onSelect: i.shuffle }] : []),
    ...(one ? [artist(one)] : []),
    ...(i.canCare && i.ownPhysical
      ? [{ key: 'own', label: i.ownPhysical.pending ? 'Adding…' : 'I own this on vinyl/CD', hint: 'Adds it to your physical collection and Discogs', icon: 'disc' as const, disabled: i.ownPhysical.pending, onSelect: i.ownPhysical.onSelect }]
      : []),
  ];
  const rows: AlbumMenuAction[] = [
    ...(i.queue ? [
      { key: 'next', label: 'Play next', icon: 'next' as const, onSelect: i.queue.next },
      { key: 'queue', label: 'Add to queue', icon: 'queue' as const, onSelect: i.queue.end },
    ] : []),
    ...(i.addToPlaylist ? [{ key: 'playlist', label: 'Add to playlist…', icon: 'playlist' as const, onSelect: i.addToPlaylist }] : []),
    { key: 'info', label: 'Album info', hint: 'Details and reviews', icon: 'info', onSelect: i.onInfo },
    ...(one ? [] : i.artists.map(artist)),
  ];
  return {
    tiles,
    rows,
    tools: i.canCare && i.maintenance ? [...(i.tools ?? [])] : [],
    maintenance: i.canCare ? { on: i.maintenance, onToggle: i.onToggleMaintenance } : null,
    ...(i.listen && i.listen.length > 0 ? { listen: [...i.listen] } : {}),
  };
}

/** "Artist page" or "Search" beside a link that is not the album itself. */
export const listenKindLabel = (l: ListenLinkView): string | null => (l.kind === 'artist' ? 'Artist page' : l.kind === 'search' ? 'Search' : null);

export const maintenanceLabel = (on: boolean) => (on ? 'Turn off Maintenance' : 'Turn on Maintenance');

/** The same menu as a desktop dropdown's items, in the drawer's order. */
export function albumMenuItems(m: AlbumMenuModel): MenuItem[] {
  const item = (a: AlbumMenuAction): MenuItem => ({
    key: a.key, label: a.label, onSelect: a.onSelect,
    ...(a.hint ? { hint: a.hint } : {}), ...(a.disabled ? { disabled: true } : {}), ...(a.separated ? { separated: true } : {}),
  });
  const tools = m.tools.map((t, n) => ({ ...item(t), separated: n === 0 || !!t.separated }));
  const listen = (m.listen ?? []).map((l, n): MenuItem => {
    const kind = listenKindLabel(l);
    return { key: `listen-${l.platform}`, label: `Listen on ${l.name}`, href: l.url, ...(kind ? { hint: kind } : {}), ...(n === 0 ? { separated: true } : {}) };
  });
  return [
    ...m.tiles.map(item),
    ...m.rows.map(item),
    ...listen,
    ...tools,
    ...(m.maintenance ? [{
      key: 'mode', label: maintenanceLabel(m.maintenance.on), separated: true,
      ...(m.maintenance.on ? {} : { hint: 'Show match state, library issues and tools' }),
      onSelect: m.maintenance.onToggle,
    }] : []),
  ];
}
