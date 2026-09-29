/**
 * The album list's selection, kept outside the page so it survives a trip to
 * an album and back: the list unmounts on /albums/$albumId, and coming back
 * restores the same selection (and scroll position) for the same query.
 * Going anywhere else while albums are selected asks first (the guard in
 * AlbumSelectionGuard uses `selectionLeaveRule`), and clears on accept.
 *
 * The state is one small module-level store mirrored to sessionStorage, so a
 * reload of the tab keeps it too. Everything here is pure or storage-guarded,
 * so the rules are unit-tested without a DOM.
 */
import { useSyncExternalStore } from 'react';
import type { AlbumsSearch } from './albumsSearch';

export interface AlbumListMemory {
  /** The list query the selection belongs to (filters + sort, not the view). */
  queryKey: string;
  /** The full /albums search of that list, to link back to it. */
  search: AlbumsSearch;
  ids: string[];
  /** "Select all N matching": every album of the query, loaded or not. */
  allMatching: boolean;
  /** Albums matching the query, for the count when allMatching. */
  total: number;
  /** Where the last plain click or toggle landed; shift-click ranges from here. */
  anchorId: string | null;
  scrollTop: number;
}

const STORAGE_KEY = 'liner.albums.selection';

const EMPTY: AlbumListMemory = { queryKey: '', search: {}, ids: [], allMatching: false, total: 0, anchorId: null, scrollTop: 0 };

/** The selection key of a list: everything that changes which albums it shows, in which order. */
export function albumsSelectionKey(search: AlbumsSearch): string {
  const { view: _view, ...rest } = search;
  const sorted = Object.keys(rest).sort().reduce<Record<string, unknown>>((acc, k) => {
    const v = (rest as Record<string, unknown>)[k];
    if (v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)) acc[k] = v;
    return acc;
  }, {});
  return JSON.stringify(sorted);
}

export function selectionSize(m: Pick<AlbumListMemory, 'allMatching' | 'total' | 'ids'>): number {
  return m.allMatching ? m.total : m.ids.length;
}

/* ---------------- range selection ---------------- */

export interface RangeResult {
  /** Ids to add to the selection. */
  ids: string[];
  /** False when the anchor is not among the loaded items: only the target was taken. */
  anchorFound: boolean;
}

/**
 * Shift-click: every item between the anchor and the target, inclusive, in the
 * list's current order. Pages load contiguously from the top, so a range
 * between two loaded items is always fully loaded. When the anchor is not
 * loaded (the list reloaded since), only the target is taken.
 */
export function rangeIds(items: ReadonlyArray<{ id: string }>, anchorId: string | null, targetIndex: number): RangeResult {
  const target = items[targetIndex];
  if (!target) return { ids: [], anchorFound: false };
  const from = anchorId == null ? -1 : items.findIndex((it) => it.id === anchorId);
  if (from < 0) return { ids: [target.id], anchorFound: anchorId == null };
  const [lo, hi] = from <= targetIndex ? [from, targetIndex] : [targetIndex, from];
  const ids: string[] = [];
  for (let i = lo; i <= hi; i++) { const it = items[i]; if (it) ids.push(it.id); }
  return { ids, anchorFound: true };
}

/** Add ids to a selection, keeping order and uniqueness. */
export function withIds(current: readonly string[], add: readonly string[]): string[] {
  const seen = new Set(current);
  const out = [...current];
  for (const id of add) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

export function toggled(current: readonly string[], id: string): string[] {
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

/* ---------------- navigation guard rule ---------------- */

const ALBUM_DETAIL = /^\/albums\/[^/]+\/?$/;
const ALBUM_LIST = /^\/albums\/?$/;

export interface LeaveInput {
  /** How many albums are selected (0: nothing to protect). */
  count: number;
  selectionKey: string;
  fromPath: string;
  toPath: string;
  /** Selection key of the destination when it is the album list. */
  toKey: string | null;
}

/**
 * 'allow': go without asking; 'confirm': ask "Leave and clear your selection?".
 *
 *  - nothing selected: allow
 *  - into an album: allow (the selection is waiting on the way back)
 *  - back to the same list: allow
 *  - to the list with other filters, from the list itself: allow — changing a
 *    filter starts a new selection, as it always has
 *  - to the list with other filters from elsewhere, or anywhere else: confirm
 */
export function selectionLeaveRule(input: LeaveInput): 'allow' | 'confirm' {
  if (input.count <= 0) return 'allow';
  if (ALBUM_DETAIL.test(input.toPath)) return 'allow';
  if (ALBUM_LIST.test(input.toPath)) {
    if (input.toKey === input.selectionKey) return 'allow';
    if (ALBUM_LIST.test(input.fromPath)) return 'allow';
    return 'confirm';
  }
  return 'confirm';
}

export function leaveMessage(count: number): string {
  return `Leave and clear your selection of ${count.toLocaleString()} album${count === 1 ? '' : 's'}?`;
}

/* ---------------- the store ---------------- */

function load(): AlbumListMemory {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<AlbumListMemory>;
    if (typeof parsed.queryKey !== 'string' || !Array.isArray(parsed.ids)) return EMPTY;
    return {
      ...EMPTY,
      ...parsed,
      ids: parsed.ids.filter((x): x is string => typeof x === 'string'),
    };
  } catch {
    return EMPTY;
  }
}

let state: AlbumListMemory = load();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage blocked: memory still holds it */ }
  }, 150);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function getAlbumListMemory(): AlbumListMemory {
  return state;
}

export function setAlbumListMemory(next: AlbumListMemory | ((prev: AlbumListMemory) => AlbumListMemory)) {
  const value = typeof next === 'function' ? next(state) : next;
  if (value === state) return;
  state = value;
  persistSoon();
  listeners.forEach((l) => l());
}

/** Scroll position changes often and nothing renders from it: store without notifying. */
export function rememberScroll(queryKey: string, scrollTop: number) {
  if (state.queryKey !== queryKey || state.scrollTop === scrollTop) return;
  state = { ...state, scrollTop };
  persistSoon();
}

export function clearAlbumSelection() {
  setAlbumListMemory((prev) => (prev.ids.length === 0 && !prev.allMatching && prev.anchorId === null
    ? prev
    : { ...prev, ids: [], allMatching: false, anchorId: null }));
}

export function useAlbumListMemory(): AlbumListMemory {
  return useSyncExternalStore(subscribe, getAlbumListMemory, getAlbumListMemory);
}

/** The /albums search to link back to while a selection is waiting there, else undefined. */
export function useAlbumsReturnSearch(): AlbumsSearch | undefined {
  const m = useAlbumListMemory();
  return selectionSize(m) > 0 ? m.search : undefined;
}

/** Test hook: reset the store. */
export function __resetAlbumListMemory() {
  state = EMPTY;
  listeners.forEach((l) => l());
}
