import { Input, Select } from '../components/ui/FormControl';
import { Button, Chip, confirmDialog, CoverArt } from '../components/ui';
/**
 * Album grid (spec BRW-1): virtualized infinite grid/list over the whole
 * library, filter rail with facet counts, multi-select filters, bulk actions
 * on a selection (§14.2). Every filter, the sort and the view mode live in
 * the URL so a view is bookmarkable; saved views store that same query.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { AlbumSummary, BulkAlbumAction, BulkAlbumsResult, MultiFilterKey, SavedView } from '@liner/shared';
import { useCurrentLibrary, useAlbumFacets, useSavedViews, useCreateSavedView, useDeleteSavedView } from '../hooks';
import { useAlbumsInfinite, useBulkAlbums } from '../hooks/useAlbumsGrid';
import { FilterRail } from '../components/FilterRail';
import { BulkTagEditor } from '../components/BulkTagEditor';
import { useMergeAlbums } from '../hooks/useCompilations';
import { activeFilterCount, albumsQueryOf, toggleMulti, type AlbumsSearch } from './albumsSearch';
import {
  albumsSelectionKey, clearAlbumSelection, getAlbumListMemory, leaveMessage, rangeIds, rememberScroll, selectionSize,
  setAlbumListMemory, toggled, useAlbumListMemory, withIds,
} from './albumSelection';
import { PlanWizard } from '../components/PlanWizard';
import styles from './AlbumsPage.module.css';

const MIN_CARD = 200;
const GRID_GAP = 24;
/** Card chrome around the square cover: padding, gap, title (2 lines), artist, stats. */
const CARD_CHROME = 106;
const LIST_ROW = 46;
/** The API caps one bulk call at 1000 ids. */
const BULK_ID_CHUNK = 1000;
/** A scroll restore that has not landed by then stops where it is. */
const RESTORE_GIVE_UP_MS = 8000;

const STATE_LABEL: Record<string, string> = {
  matched: 'Matched', needs_review: 'Needs review', unidentified: 'Unidentified', pending: 'Pending', as_is: 'Kept as-is', ignored: 'Ignored',
};
const CHIP_LABEL: Record<string, string> = {
  q: 'search', artist: 'artist', state: 'state', decided: 'match', review: 'reviews', genre: 'genre', decade: 'decade',
  format: 'format', label: 'label', owned: 'collection', gap: 'attention',
};
const KIND_TAG: Record<string, string> = { chip_rule: 'chips', first_candidate: '1st cand', by_me: 'me', manual_mbid: 'mbid' };
const BULK_LABEL: Record<BulkAlbumAction, string> = {
  identify: 'Re-identify', fetch_art: 'Fetch art', as_is: 'Keep as-is', ignore: 'Ignore', unignore: 'Un-ignore', prefer: 'Mark preferred',
};
const MULTI_KEYS: MultiFilterKey[] = ['state', 'genre', 'decade', 'format', 'label', 'gap'];

function formatLabel(a: AlbumSummary): string {
  if (a.isLossless) return 'Lossless';
  if (a.isMixed) return 'Mixed';
  return (a.formats[0] ?? '').toUpperCase();
}

export function AlbumsPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as AlbumsSearch;
  const { libraryId } = useCurrentLibrary();
  const query = albumsQueryOf(search);
  const sort = search.sort ?? 'artist';
  const view = search.view ?? 'grid';
  const activeCount = activeFilterCount(search);

  // Search box: local echo, URL after a short pause.
  const [q, setQ] = useState(search.q ?? '');

  type SearchPatch = { [K in keyof AlbumsSearch]?: AlbumsSearch[K] | undefined };
  /**
   * Every change of this list's filters, search or sort comes through here. A
   * different list starts a new selection, so with albums selected it asks
   * first; Stay keeps the list (and puts the search box back) as it was.
   * Clearing before navigating lets AlbumSelectionGuard pass it without asking again.
   */
  const goToList = useCallback(async (next: AlbumsSearch) => {
    const m = getAlbumListMemory();
    const count = selectionSize(m);
    if (count > 0 && m.queryKey === albumsSelectionKey(search) && albumsSelectionKey(next) !== m.queryKey) {
      const ok = await confirmDialog({
        title: leaveMessage(count),
        message: 'Changing the filters, search or sort starts a new selection. The albums themselves are not changed.',
        confirmLabel: 'Change and clear',
        cancelLabel: 'Stay',
      });
      if (!ok) { setQ(search.q ?? ''); return; }
      clearAlbumSelection();
    }
    void navigate({ to: '/albums', search: next as never });
  }, [navigate, search]);
  const setSearch = useCallback((patch: SearchPatch) => {
    const next: Record<string, unknown> = { ...search, ...patch };
    for (const k of Object.keys(next)) {
      const v = next[k];
      if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) delete next[k];
    }
    void goToList(next as AlbumsSearch);
  }, [goToList, search]);

  useEffect(() => { setQ(search.q ?? ''); }, [search.q]);
  useEffect(() => {
    if ((search.q ?? '') === q.trim()) return;
    const t = setTimeout(() => setSearch({ q: q.trim() || undefined }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } = useAlbumsInfinite(libraryId, query, sort);
  const { data: facets } = useAlbumFacets(libraryId, query);
  const { data: savedViews } = useSavedViews(libraryId);
  const createView = useCreateSavedView(libraryId);
  const deleteView = useDeleteSavedView(libraryId);
  const bulk = useBulkAlbums(libraryId);
  const [railOpen, setRailOpen] = useState(false);

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const total = facets?.total ?? items.length;

  /* ---- selection (§14.2: checkbox, ⌘-click, shift-range, select-all-matching) ----
     Lives in a store outside the page (albumSelection.ts) so it survives a trip
     into an album and back; AlbumSelectionGuard asks before anything else drops it. */
  const memory = useAlbumListMemory();
  const queryKey = albumsSelectionKey(search);
  const [bulkResult, setBulkResult] = useState<BulkAlbumsResult | null>(null);
  const [rangeNote, setRangeNote] = useState<string | null>(null);
  const shiftClick = useRef(false);
  // Another list (a filter changed, or we came from elsewhere): a fresh selection.
  const current = memory.queryKey === queryKey;
  const searchJson = JSON.stringify(search);
  useEffect(() => {
    setAlbumListMemory((prev) => (prev.queryKey === queryKey
      ? (JSON.stringify(prev.search) === searchJson ? prev : { ...prev, search })
      : { queryKey, search, ids: [], allMatching: false, total: 0, anchorId: null, scrollTop: 0 }));
    setRangeNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, searchJson]);
  useEffect(() => {
    if (facets) setAlbumListMemory((prev) => (prev.queryKey === queryKey && prev.total !== facets.total ? { ...prev, total: facets.total } : prev));
  }, [facets, queryKey]);

  const allMatching = current && memory.allMatching;
  const selectedIds = useMemo(() => (current ? memory.ids : []), [current, memory.ids]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectionCount = allMatching ? total : selected.size;
  /** Toggling one album out of "all matching" starts from every loaded album. */
  const baseIds = () => (allMatching ? items.map((it) => it.id) : selectedIds);
  const toggleOne = (id: string) => {
    setRangeNote(null);
    setAlbumListMemory((prev) => ({ ...prev, queryKey, ids: toggled(baseIds(), id), allMatching: false, anchorId: id }));
  };
  const selectRange = (index: number) => {
    const { ids, anchorFound } = rangeIds(items, current ? memory.anchorId : null, index);
    if (ids.length === 0) return;
    setRangeNote(anchorFound ? null : 'The start of that range is no longer loaded, so only this album was added.');
    setAlbumListMemory((prev) => ({
      ...prev, queryKey, ids: withIds(baseIds(), ids), allMatching: false,
      anchorId: anchorFound && prev.anchorId ? prev.anchorId : ids[ids.length - 1] ?? null,
    }));
  };
  const setAllMatching = (on: boolean) => setAlbumListMemory((prev) => ({ ...prev, queryKey, allMatching: on }));
  const clearSelection = () => { setRangeNote(null); clearAlbumSelection(); };
  /** Checkbox or Space: toggle; with Shift: extend the range from the last one. */
  const pick = (id: string, index: number, shift: boolean) => {
    if (shift) selectRange(index); else toggleOne(id);
  };

  /* ---- compilations: set album values for the selection, or treat it as one album ---- */
  const [editingIds, setEditingIds] = useState<string[] | null>(null);
  const [mergeNote, setMergeNote] = useState<string | null>(null);
  const merge = useMergeAlbums(libraryId);
  const mergeSelected = async () => {
    const ids = [...selected];
    if (ids.length < 2) return;
    if (!(await confirmDialog({ title: `Treat these ${ids.length} albums as one?`, message: 'Nothing on disk moves. You can split them back from the album page.', confirmLabel: 'Treat as one album' }))) return;
    setMergeNote(null);
    try {
      const r = await merge.mutateAsync({ albumIds: ids });
      clearSelection();
      void navigate({ to: '/albums/$albumId', params: { albumId: r.albumId } });
    } catch (e) {
      setMergeNote((e as { detail?: string })?.detail ?? 'The albums could not be merged.');
    }
  };

  const runBulk = async (action: BulkAlbumAction) => {
    const count = selectionCount;
    if (count === 0) return;
    const changesState = action === 'ignore' || action === 'as_is' || action === 'unignore' || action === 'prefer';
    if ((changesState || count > 200) && !(await confirmDialog({ title: `${BULK_LABEL[action]}: ${count.toLocaleString()} album${count === 1 ? '' : 's'}?`, confirmLabel: BULK_LABEL[action] }))) return;
    setBulkResult(null);
    if (allMatching) {
      const res = await bulk.mutateAsync({ action, allMatching: true, query });
      setBulkResult(res);
    } else {
      const ids = [...selected];
      const totals: BulkAlbumsResult = { action, matched: 0, updated: 0, queued: 0, skippedAlreadyQueued: 0, capped: false };
      for (let i = 0; i < ids.length; i += BULK_ID_CHUNK) {
        const res = await bulk.mutateAsync({ action, albumIds: ids.slice(i, i + BULK_ID_CHUNK) });
        totals.matched += res.matched; totals.updated += res.updated; totals.queued += res.queued;
        totals.skippedAlreadyQueued += res.skippedAlreadyQueued ?? 0;
        totals.capped = totals.capped || res.capped;
      }
      setBulkResult(totals);
    }
    clearSelection();
  };

  /* ---- virtualization ---- */
  // A callback ref, not an effect: the scroll container mounts only after the
  // library resolves, and an effect keyed on `view` would never see it.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    scrollRef.current = el;
    if (!el) return;
    const measure = () => setGridWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    observerRef.current = ro;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const minCard = gridWidth < 600 ? 140 : MIN_CARD;
  const cols = Math.max(1, Math.floor((gridWidth + GRID_GAP) / (minCard + GRID_GAP))) || 1;
  const cardWidth = cols > 0 && gridWidth > 0 ? Math.floor((gridWidth - (cols - 1) * GRID_GAP) / cols) : MIN_CARD;
  const rowHeight = view === 'list' ? LIST_ROW : cardWidth + CARD_CHROME + GRID_GAP;
  const rowCount = view === 'list' ? items.length : Math.ceil(items.length / cols);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: view === 'list' ? 12 : 4,
  });
  const virtualRows = virtualizer.getVirtualItems();

  // Pull the next page while the tail is still off-screen.
  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (!last || !hasNextPage || isFetchingNextPage) return;
    if (last.index >= rowCount - 3) void fetchNextPage();
  }, [virtualRows, hasNextPage, isFetchingNextPage, rowCount, fetchNextPage]);

  useEffect(() => { virtualizer.measure(); }, [rowHeight, virtualizer]);

  /* ---- scroll: remembered per list, restored on the way back from an album ---- */
  const restoreTo = useRef<number | null>(null);
  const restoreKey = useRef<string | null>(null);
  const restoreStarted = useRef(0);
  if (restoreKey.current !== queryKey) {
    // First render for this list: pick up where it was left, if it was this list.
    restoreKey.current = queryKey;
    const m = getAlbumListMemory();
    restoreTo.current = m.queryKey === queryKey && m.scrollTop > 0 ? m.scrollTop : null;
    restoreStarted.current = Date.now();
  }
  const totalSize = virtualizer.getTotalSize();
  useEffect(() => {
    const el = scrollRef.current;
    const target = restoreTo.current;
    if (target == null) return;
    // A failed page load or a restore that drags on gives up where it is, so
    // scrolling is remembered again from here on.
    if (error || Date.now() - restoreStarted.current > RESTORE_GIVE_UP_MS) { restoreTo.current = null; return; }
    if (!el || items.length === 0) return;
    el.scrollTop = target;
    // Reached it, or nothing more to load: done. Otherwise the scroll to the
    // bottom pulls the next page and this runs again with a taller canvas.
    if (Math.abs(el.scrollTop - target) < 2 || (!hasNextPage && !isFetchingNextPage)) restoreTo.current = null;
  }, [totalSize, items.length, hasNextPage, isFetchingNextPage, error]);
  // The give-up time also applies when nothing rerenders (a page load that hangs).
  useEffect(() => {
    if (restoreTo.current == null) return;
    const t = setTimeout(() => { restoreTo.current = null; }, RESTORE_GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [queryKey]);
  const onGridScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (restoreTo.current != null) return;
    rememberScroll(queryKey, e.currentTarget.scrollTop);
  }, [queryKey]);
  // The owner scrolling (wheel, touch, the scrollbar, the keyboard) takes over
  // from a restore still in progress.
  const stopRestore = useCallback(() => { restoreTo.current = null; }, []);

  const [planIds, setPlanIds] = useState<string[] | null>(null);
  const labelsFor = (ids: string[]) => {
    const want = new Set(ids);
    return Object.fromEntries(items.filter((it) => want.has(it.id)).map((it) => [it.id, `${it.artistCredit} – ${it.title}`]));
  };

  if (!libraryId) return <div className={styles.container} data-virtual-page>Loading library...</div>;

  const open = (albumId: string) => navigate({ to: `/albums/${albumId}` });
  const clearAll = () => void goToList({ ...(search.sort && { sort: search.sort }), ...(search.view && { view: search.view }) });
  const applyView = (v: SavedView) => void goToList(v.query as AlbumsSearch);
  const saveView = () => {
    const name = window.prompt('Name this view', '');
    if (!name?.trim()) return;
    createView.mutate({ name: name.trim(), query: albumsQueryOf(search) });
  };
  const onCardActivate = (e: React.MouseEvent, album: AlbumSummary, index: number) => {
    if (e.metaKey || e.ctrlKey) { toggleOne(album.id); return; }
    if (e.shiftKey) { selectRange(index); return; }
    open(album.id);
  };
  const isSelected = (id: string) => allMatching || selected.has(id);
  /** Enter opens; Space toggles the focused album, Shift+Space extends the range to it. */
  const onItemKey = (e: React.KeyboardEvent, album: AlbumSummary, index: number) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') { open(album.id); return; }
    if (e.key === ' ') { e.preventDefault(); pick(album.id, index, e.shiftKey); }
  };
  /* The checkbox: a click toggles, a shift-click selects the range up to it.
     React fires onClick before onChange for the same click, so the label (which
     every click on the box bubbles through) notes Shift and keeps the click off
     the card, and onChange acts on it. */
  const onCheckClick = (e: React.MouseEvent) => { e.stopPropagation(); shiftClick.current = e.shiftKey; };
  const onCheckChange = (album: AlbumSummary, index: number) => {
    pick(album.id, index, shiftClick.current);
    shiftClick.current = false;
  };

  const chips = (Object.entries(query) as Array<[keyof typeof query, unknown]>)
    .filter(([k, v]) => v !== undefined && v !== '' && k !== 'sort' && k !== 'view')
    .flatMap(([k, v]) => {
      const label = CHIP_LABEL[k] ?? k;
      if (Array.isArray(v)) {
        return v.map((item) => ({
          key: `${k}:${item}`,
          text: `${label}: ${k === 'state' ? STATE_LABEL[String(item)] ?? item : k === 'decade' ? `${item}s` : item}`,
          clear: () => setSearch({ [k]: toggleMulti(search, k as MultiFilterKey, item as string | number) } as SearchPatch),
        }));
      }
      return [{ key: String(k), text: `${label}: ${v}`, clear: () => setSearch({ [k]: undefined } as SearchPatch) }];
    });

  const showEmpty = !isLoading && !error && items.length === 0;

  return (
    <div className={styles.container} data-virtual-page>
      <header className={styles.header}>
        <h1 className={styles.title}>Albums</h1>
        <p className={styles.intro}>Every record, a world to explore.</p>
        <div className={styles.toolbar}>

          <Button variant="secondary" onClick={() => setRailOpen((o) => !o)} aria-expanded={railOpen}>
            {railOpen ? 'Hide filters' : `Filters${activeCount ? ` (${activeCount})` : ''}`}
          </Button>
          <Input
            type="text"
            className={styles.searchInput}
            placeholder="Search albums, artists…"
            aria-label="Search albums and artists"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Select className={styles.select} value={sort} onChange={(e) => setSearch({ sort: e.target.value as AlbumsSearch['sort'] })} aria-label="Sort albums">
            <option value="artist">Artist A–Z</option>
            <option value="title">Title A–Z</option>
            <option value="year">Year, newest</option>
            <option value="added_date">Recently added</option>
            <option value="rating">Your rating</option>
            <option value="listened">Last listened</option>
          </Select>
          <span className={styles.countInfo}>
            {facets ? `${total.toLocaleString()} albums` : ''}
          </span>
          <div className={styles.viewToggle} role="group" aria-label="View mode">
            <Button size="sm" variant={view === 'grid' ? 'secondary' : 'quiet'} aria-pressed={view === 'grid'} onClick={() => setSearch({ view: undefined })}>Grid</Button>
            <Button size="sm" variant={view === 'list' ? 'secondary' : 'quiet'} aria-pressed={view === 'list'} onClick={() => setSearch({ view: 'list' })}>List</Button>
          </div>
        </div>

        {chips.length > 0 && (
          <div className={styles.chips}>
            {chips.map((c) => (
              <Chip key={c.key} active aria-pressed={undefined} onClick={c.clear} title="Remove filter">{c.text} <span aria-hidden="true">✕</span></Chip>
            ))}
            <Button variant="quiet" size="sm" onClick={clearAll}>Clear all</Button>
          </div>
        )}

        {selectionCount > 0 && (
          <div className={styles.bulkBar}>
            <strong>{selectionCount.toLocaleString()} selected</strong>
            {!allMatching && items.length > 0 && total > selected.size && (
              <Button variant="quiet" size="sm" onClick={() => setAllMatching(true)}>
                Select all {total.toLocaleString()} matching
              </Button>
            )}
            <Button variant="quiet" size="sm" onClick={clearSelection}>Clear selection</Button>
            {rangeNote && <span className={styles.muted} role="status">{rangeNote}</span>}
            <span className={styles.bulkActions}>
              {(['identify', 'fetch_art', 'as_is', 'ignore', 'unignore', 'prefer'] as BulkAlbumAction[]).map((a) => (
                <Button key={a} variant="secondary" size="sm" disabled={bulk.isPending} onClick={() => void runBulk(a)}>
                  {BULK_LABEL[a]}
                </Button>
              ))}
              <Button
                variant="secondary"
                size="sm"
                disabled={allMatching || selected.size < 2 || selected.size > 200 || merge.isPending}
                title={selected.size < 2 ? 'Select two or more albums' : 'Make the selected albums one album without moving files (for a compilation split across folders)'}
                onClick={() => void mergeSelected()}
              >
                {merge.isPending ? 'Merging…' : 'Treat as one album'}
              </Button>
              <Button
                size="sm"
                disabled={allMatching || selected.size === 0 || selected.size > BULK_ID_CHUNK}
                title={allMatching ? 'Pick albums one by one to edit their tags together' : 'Set album artist, title, year, compilation or genre for every file in the selection; you preview before anything is written'}
                onClick={() => setEditingIds([...selected])}
              >
                Set album values…
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={allMatching || selected.size === 0 || selected.size > BULK_ID_CHUNK}
                title={allMatching ? 'Pick albums one by one to add them to a plan' : 'Add the selected albums to a tag plan; you preview every change before anything is written'}
                onClick={() => setPlanIds([...selected])}
              >
                Add to plan…
              </Button>
            </span>
            {bulk.isPending && <span className={styles.muted}>working…</span>}
            {mergeNote && <span className={styles.muted} role="status">{mergeNote}</span>}
          </div>
        )}
        {editingIds && libraryId && (
          <BulkTagEditor
            libraryId={libraryId}
            scopes={[{ key: 'selection', label: `${editingIds.length} selected album${editingIds.length === 1 ? '' : 's'}`, scope: { type: 'albumIds', albumIds: editingIds } }]}
            title={`Set album values · ${editingIds.length} album${editingIds.length === 1 ? '' : 's'}`}
            onClose={() => setEditingIds(null)}
          />
        )}
        {/* Once the selection is in the plan it is dropped, so moving on to the plan page does not ask. */}
        {planIds && libraryId && (
          <PlanWizard
            libraryId={libraryId}
            initialScope={{ albumIds: planIds, albumLabels: labelsFor(planIds) }}
            onDone={clearSelection}
            onClose={() => setPlanIds(null)}
          />
        )}
        {bulkResult && !bulk.isPending && (
          <div className={styles.bulkResult}>
            {BULK_LABEL[bulkResult.action]}: {bulkResult.updated ? `${bulkResult.updated.toLocaleString()} updated` : ''}
            {bulkResult.queued ? `${bulkResult.queued.toLocaleString()} queued` : ''}
            {bulkResult.skippedAlreadyQueued ? `${bulkResult.queued ? ', ' : ''}${bulkResult.skippedAlreadyQueued.toLocaleString()} already queued (moved ahead of the sweep)` : ''}
            {!bulkResult.updated && !bulkResult.queued && !bulkResult.skippedAlreadyQueued ? 'nothing to do' : ''}
            {bulkResult.capped ? ' (capped — run again for the rest)' : ''}
            <Button variant="quiet" size="sm" onClick={() => setBulkResult(null)}>Dismiss</Button>
          </div>
        )}
      </header>

      <div className={styles.body}>
        {railOpen && (
          <FilterRail
            query={query}
            facets={facets}
            savedViews={savedViews}
            activeCount={activeCount}
            onToggle={(key, value) => setSearch({ [key]: toggleMulti(search, key, value) } as SearchPatch)}
            onSet={(key, value) => setSearch({ [key]: value } as SearchPatch)}
            onClear={clearAll}
            onApplyView={applyView}
            onSaveView={saveView}
            onDeleteView={async (id) => { if (await confirmDialog({ title: 'Delete this saved view?', message: 'The albums are not affected, only the saved filters.', confirmLabel: 'Delete', tone: 'danger' })) deleteView.mutate(id); }}
          />
        )}

        <div className={styles.main}>
          {error && <div className={styles.error} role="alert">Couldn’t load albums. <Button variant="secondary" size="sm" onClick={() => void refetch()}>Try again</Button></div>}
          {isLoading && <div className={styles.loading}>Loading albums...</div>}

          {showEmpty && (
            <div className={styles.emptyState}>
              <h2>{activeCount > 0 ? 'No albums match these filters' : 'No albums found'}</h2>
              {activeCount > 0
                ? <p><Button variant="secondary" onClick={clearAll}>Clear filters</Button></p>
                : <p>Start scanning in Settings to build your library.</p>}
            </div>
          )}

          <div className={styles.gridContainer} ref={attachScroller} data-selecting={selectionCount > 0 ? '' : undefined} onScroll={onGridScroll} onWheel={stopRestore} onTouchStart={stopRestore} onPointerDown={stopRestore} onKeyDown={stopRestore}>
            {items.length > 0 && (gridWidth > 0 || view === 'list') && (
              <div className={styles.virtualCanvas} style={{ height: virtualizer.getTotalSize() }}>
                {virtualRows.map((row) => {
                  const style: React.CSSProperties = {
                    position: 'absolute', top: 0, left: 0, width: '100%',
                    transform: `translateY(${row.start}px)`, height: rowHeight,
                  };
                  if (view === 'list') {
                    const album = items[row.index];
                    if (!album) return null;
                    const selectedRow = isSelected(album.id);
                    return (
                      <div
                        key={album.id}
                        className={selectedRow ? styles.listRowSelected : styles.listRow}
                        style={style}
                        onClick={(e) => onCardActivate(e, album, row.index)}
                        role="button"
                        tabIndex={0}
                        aria-label={album.title}
                        onKeyDown={(e) => onItemKey(e, album, row.index)}
                      >
                        <label className={styles.rowCheck} onClick={onCheckClick}>
                          <input
                            type="checkbox"
                            className={styles.rowCheckbox}
                            checked={selectedRow}
                            onChange={() => onCheckChange(album, row.index)}
                            aria-label={`Select ${album.title}`}
                          />
                        </label>
                        <span className={styles.thumb}><CoverArt src={album.coverUrl} title={album.title} compact /></span>
                        <span className={styles.listTitle}>{album.title}</span>
                        <span className={styles.listArtist}>{album.artistCredit}</span>
                        <span className={styles.listYear}>{album.year ?? '–'}</span>
                        <span className={styles.listTracks}>
                          {album.canonicalTrackCount != null && album.trackCount < album.canonicalTrackCount
                            ? <span className={styles.incomplete}>{album.trackCount}/{album.canonicalTrackCount}</span>
                            : album.trackCount}
                        </span>
                        <span className={album.isLossless ? styles.formatLossless : album.isMixed ? styles.formatMixed : styles.formatTag}>
                          {formatLabel(album)}
                        </span>
                        <span className={styles.listState}>{STATE_LABEL[album.state] ?? album.state}</span>
                        <span className={styles.listBadges}>
                          {album.needsAttention && <span className={styles.inlineDot} title="Needs attention" />}
                          {album.ownRating != null && <span title="Your rating">★ {album.ownRating}</span>}
                          {album.hasReview && <span title="Reviewed">✎</span>}
                        </span>
                      </div>
                    );
                  }
                  const rowItems = items.slice(row.index * cols, row.index * cols + cols);
                  return (
                    <div key={row.key} className={styles.gridRow} style={{ ...style, gap: GRID_GAP }}>
                      {rowItems.map((album, i) => {
                        const index = row.index * cols + i;
                        const selectedCard = isSelected(album.id);
                        return (
                          <div
                            key={album.id}
                            className={selectedCard ? styles.albumCardSelected : styles.albumCard}
                            style={{ width: cardWidth }}
                            onClick={(e) => onCardActivate(e, album, index)}
                            role="button"
                            tabIndex={0}
                            aria-label={`${album.title}, ${album.artistCredit}`}
                            onKeyDown={(e) => onItemKey(e, album, index)}
                          >
                            <div className={styles.albumCover} style={{ height: cardWidth - 32 }}>
                              <label className={selectedCard ? styles.cardCheckOn : styles.cardCheck} onClick={onCheckClick}>
                                <input
                                  type="checkbox"
                                  className={styles.cardCheckbox}
                                  checked={selectedCard}
                                  onChange={() => onCheckChange(album, index)}
                                  aria-label={`Select ${album.title}`}
                                />
                              </label>
                              {album.needsAttention && <span className={styles.attentionDot} title="Needs attention" />}
                              {album.hasReview && <span className={styles.reviewedDot} title="Reviewed" />}
                              {album.ownRating != null && (
                                <span className={styles.ratingBadge} title={`Your rating: ${album.ownRating}`}>★ {album.ownRating}</span>
                              )}
                              {album.canonicalTrackCount != null && album.trackCount < album.canonicalTrackCount && (
                                <span className={styles.trackBadge}>{album.trackCount}/{album.canonicalTrackCount}</span>
                              )}
                              <CoverArt src={album.coverUrl} title={album.title} fill />
                            </div>
                            <div className={styles.albumInfo}>
                              <h3 className={styles.albumTitle}>{album.title}</h3>
                              <p className={styles.albumArtist}>{album.artistCredit}</p>
                              <p className={styles.albumStats}>
                                <span className={album.isLossless ? styles.formatLossless : album.isMixed ? styles.formatMixed : styles.formatTag}>{formatLabel(album)}</span>
                                {' · '}{album.trackCount} {album.trackCount === 1 ? 'track' : 'tracks'}
                                {album.year ? ` · ${album.year}` : ''}
                                {album.matchKind && album.matchKind !== 'auto_strong' && (
                                  <span className={styles.kindTag}> · {KIND_TAG[album.matchKind] ?? ''}</span>
                                )}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
            {isFetchingNextPage && <div className={styles.loadingMore}>Loading more…</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
