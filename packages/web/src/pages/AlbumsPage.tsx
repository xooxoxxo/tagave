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
import { activeFilterCount, albumsQueryOf, toggleMulti, type AlbumsSearch } from './albumsSearch';
import styles from './AlbumsPage.module.css';

const MIN_CARD = 160;
const GRID_GAP = 16;
/** Card chrome around the square cover: padding, gap, title (2 lines), artist, stats. */
const CARD_CHROME = 106;
const LIST_ROW = 46;
/** The API caps one bulk call at 1000 ids. */
const BULK_ID_CHUNK = 1000;

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

  type SearchPatch = { [K in keyof AlbumsSearch]?: AlbumsSearch[K] | undefined };
  const setSearch = useCallback((patch: SearchPatch) => {
    const next: Record<string, unknown> = { ...search, ...patch };
    for (const k of Object.keys(next)) {
      const v = next[k];
      if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) delete next[k];
    }
    navigate({ to: '/albums', search: next as never });
  }, [navigate, search]);

  // Search box: local echo, URL after a short pause.
  const [q, setQ] = useState(search.q ?? '');
  useEffect(() => { setQ(search.q ?? ''); }, [search.q]);
  useEffect(() => {
    if ((search.q ?? '') === q.trim()) return;
    const t = setTimeout(() => setSearch({ q: q.trim() || undefined }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useAlbumsInfinite(libraryId, query, sort);
  const { data: facets } = useAlbumFacets(libraryId, query);
  const { data: savedViews } = useSavedViews(libraryId);
  const createView = useCreateSavedView(libraryId);
  const deleteView = useDeleteSavedView(libraryId);
  const bulk = useBulkAlbums(libraryId);
  const [railOpen, setRailOpen] = useState(true);

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const total = facets?.total ?? items.length;

  /* ---- selection (§14.2: click, ⌘-click, shift-range, select-all-matching) ---- */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkAlbumsResult | null>(null);
  const anchor = useRef<number | null>(null);
  const queryKey = JSON.stringify({ ...query, view: undefined });
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
    anchor.current = null;
  }, [queryKey]);

  const selectionCount = allMatching ? total : selected.size;
  const toggleOne = (id: string, index: number) => {
    setAllMatching(false);
    anchor.current = index;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectRange = (index: number) => {
    const from = anchor.current ?? index;
    const [lo, hi] = from <= index ? [from, index] : [index, from];
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) { const it = items[i]; if (it) next.add(it.id); }
      return next;
    });
  };
  const clearSelection = () => { setSelected(new Set()); setAllMatching(false); anchor.current = null; };

  const runBulk = async (action: BulkAlbumAction) => {
    const count = selectionCount;
    if (count === 0) return;
    const changesState = action === 'ignore' || action === 'as_is' || action === 'unignore' || action === 'prefer';
    if ((changesState || count > 200) && !window.confirm(`${BULK_LABEL[action]}: ${count.toLocaleString()} album(s)?`)) return;
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

  const cols = Math.max(1, Math.floor((gridWidth + GRID_GAP) / (MIN_CARD + GRID_GAP))) || 1;
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

  if (!libraryId) return <div className={styles.container}>Loading library...</div>;

  const open = (albumId: string) => navigate({ to: `/albums/${albumId}` });
  const clearAll = () => navigate({ to: '/albums', search: { ...(search.sort && { sort: search.sort }), ...(search.view && { view: search.view }) } as never });
  const applyView = (v: SavedView) => navigate({ to: '/albums', search: v.query as never });
  const saveView = () => {
    const name = window.prompt('Name this view', '');
    if (!name?.trim()) return;
    createView.mutate({ name: name.trim(), query: albumsQueryOf(search) });
  };
  const onCardActivate = (e: React.MouseEvent, album: AlbumSummary, index: number) => {
    if (e.metaKey || e.ctrlKey) { toggleOne(album.id, index); return; }
    if (e.shiftKey) { selectRange(index); return; }
    open(album.id);
  };
  const isSelected = (id: string) => allMatching || selected.has(id);

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

  const showEmpty = !isLoading && items.length === 0;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.toolbar}>
          <h1 className={styles.title}>Albums</h1>
          <button className={styles.toolButton} onClick={() => setRailOpen((o) => !o)} aria-pressed={railOpen}>
            {railOpen ? 'Hide filters' : `Filters${activeCount ? ` (${activeCount})` : ''}`}
          </button>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search albums, artists..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select className={styles.select} value={sort} onChange={(e) => setSearch({ sort: e.target.value as AlbumsSearch['sort'] })} title="Sort">
            <option value="artist">Artist A–Z</option>
            <option value="title">Title A–Z</option>
            <option value="year">Year, newest</option>
            <option value="added_date">Recently added</option>
            <option value="rating">Your rating</option>
            <option value="listened">Last listened</option>
          </select>
          <span className={styles.countInfo}>
            {facets ? `${total.toLocaleString()} albums` : ''}
          </span>
          <div className={styles.viewToggle} role="group" aria-label="View mode">
            <button className={view === 'grid' ? styles.toolButtonActive : styles.toolButton} onClick={() => setSearch({ view: undefined })}>Grid</button>
            <button className={view === 'list' ? styles.toolButtonActive : styles.toolButton} onClick={() => setSearch({ view: 'list' })}>List</button>
          </div>
        </div>

        {chips.length > 0 && (
          <div className={styles.chips}>
            {chips.map((c) => (
              <button key={c.key} className={styles.chip} onClick={c.clear} title="Remove filter">{c.text} ✕</button>
            ))}
            <button className={styles.chipClear} onClick={clearAll}>Clear all</button>
          </div>
        )}

        {selectionCount > 0 && (
          <div className={styles.bulkBar}>
            <strong>{selectionCount.toLocaleString()} selected</strong>
            {!allMatching && items.length > 0 && total > selected.size && (
              <button className={styles.linkButton} onClick={() => setAllMatching(true)}>
                Select all {total.toLocaleString()} matching
              </button>
            )}
            <button className={styles.linkButton} onClick={clearSelection}>Clear selection</button>
            <span className={styles.bulkActions}>
              {(['identify', 'fetch_art', 'as_is', 'ignore', 'unignore', 'prefer'] as BulkAlbumAction[]).map((a) => (
                <button key={a} className={styles.toolButton} disabled={bulk.isPending} onClick={() => void runBulk(a)}>
                  {BULK_LABEL[a]}
                </button>
              ))}
            </span>
            {bulk.isPending && <span className={styles.muted}>working…</span>}
          </div>
        )}
        {bulkResult && !bulk.isPending && (
          <div className={styles.bulkResult}>
            {BULK_LABEL[bulkResult.action]}: {bulkResult.updated ? `${bulkResult.updated.toLocaleString()} updated` : ''}
            {bulkResult.queued ? `${bulkResult.queued.toLocaleString()} queued` : ''}
            {bulkResult.skippedAlreadyQueued ? `${bulkResult.queued ? ', ' : ''}${bulkResult.skippedAlreadyQueued.toLocaleString()} already queued (moved ahead of the sweep)` : ''}
            {!bulkResult.updated && !bulkResult.queued && !bulkResult.skippedAlreadyQueued ? 'nothing to do' : ''}
            {bulkResult.capped ? ' (capped — run again for the rest)' : ''}
            <button className={styles.linkButton} onClick={() => setBulkResult(null)}>Dismiss</button>
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
            onDeleteView={(id) => { if (window.confirm('Delete this saved view?')) deleteView.mutate(id); }}
          />
        )}

        <div className={styles.main}>
          {error && <div className={styles.error}>Failed to load albums</div>}
          {isLoading && <div className={styles.loading}>Loading albums...</div>}

          {showEmpty && (
            <div className={styles.emptyState}>
              <h2>{activeCount > 0 ? 'No albums match these filters' : 'No albums found'}</h2>
              {activeCount > 0
                ? <p><button className={styles.toolButton} onClick={clearAll}>Clear filters</button></p>
                : <p>Start scanning in Settings to build your library.</p>}
            </div>
          )}

          <div className={styles.gridContainer} ref={attachScroller}>
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
                        onKeyDown={(e) => { if (e.key === 'Enter') open(album.id); }}
                      >
                        <input
                          type="checkbox"
                          className={styles.rowCheckbox}
                          checked={selectedRow}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleOne(album.id, row.index)}
                          aria-label={`Select ${album.title}`}
                        />
                        {album.coverUrl
                          ? <img className={styles.thumb} src={album.coverUrl} alt="" loading="lazy" />
                          : <span className={styles.thumbPlaceholder} />}
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
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') open(album.id); }}
                          >
                            <div className={styles.albumCover} style={{ height: cardWidth - 32 }}>
                              <input
                                type="checkbox"
                                className={selectedCard ? styles.cardCheckboxOn : styles.cardCheckbox}
                                checked={selectedCard}
                                onClick={(e) => e.stopPropagation()}
                                onChange={() => toggleOne(album.id, index)}
                                aria-label={`Select ${album.title}`}
                              />
                              {album.needsAttention && <span className={styles.attentionDot} title="Needs attention" />}
                              {album.hasReview && <span className={styles.reviewedDot} title="Reviewed" />}
                              {album.ownRating != null && (
                                <span className={styles.ratingBadge} title={`Your rating: ${album.ownRating}`}>★ {album.ownRating}</span>
                              )}
                              {album.canonicalTrackCount != null && album.trackCount < album.canonicalTrackCount && (
                                <span className={styles.trackBadge}>{album.trackCount}/{album.canonicalTrackCount}</span>
                              )}
                              {album.coverUrl
                                ? <img className={styles.coverImg} src={album.coverUrl} alt="" loading="lazy" />
                                : <div className={styles.coverPlaceholder}><span className={styles.fileCount}>{album.trackCount}</span></div>}
                            </div>
                            <div className={styles.albumInfo}>
                              <h3 className={styles.albumTitle}>{album.title}</h3>
                              <p className={styles.albumArtist}>{album.artistCredit}</p>
                              <p className={styles.albumStats}>
                                <span className={album.isLossless ? styles.formatLossless : album.isMixed ? styles.formatMixed : styles.formatTag}>{formatLabel(album)}</span>
                                {' · '}{album.trackCount} tracks
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
