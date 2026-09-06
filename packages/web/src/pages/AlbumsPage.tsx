/**
 * Album grid (spec BRW-1): filter rail with facet counts, sorts, grid/list
 * modes, badges (lossless/mixed, n/N, reviewed, rating, needs attention).
 * Every filter, the sort, the view mode and the page live in the URL so a
 * view is bookmarkable; saved views store that same query.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { AlbumSummary, SavedView } from '@liner/shared';
import {
  useCurrentLibrary, useAlbums, useAlbumFacets, useSavedViews, useCreateSavedView, useDeleteSavedView,
} from '../hooks';
import type { AlbumsFilterOptions } from '../hooks/useLibrary';
import { FilterRail } from '../components/FilterRail';
import { activeFilterCount, albumsQueryOf, type AlbumsSearch } from './albumsSearch';
import styles from './AlbumsPage.module.css';

const PAGE_SIZE = 60;

const STATE_LABEL: Record<string, string> = {
  matched: 'Matched', needs_review: 'Needs review', unidentified: 'Unidentified', pending: 'Pending', as_is: 'Kept as-is', ignored: 'Ignored',
};
const CHIP_LABEL: Record<string, string> = {
  q: 'search', artist: 'artist', state: 'state', decided: 'match', review: 'reviews', genre: 'genre', decade: 'decade',
  format: 'format', label: 'label', owned: 'collection', gap: 'attention',
};
const KIND_TAG: Record<string, string> = { chip_rule: 'chips', first_candidate: '1st cand', by_me: 'me', manual_mbid: 'mbid' };

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
  const page = search.page ?? 1;
  const sort = search.sort ?? 'artist';
  const view = search.view ?? 'grid';
  const activeCount = activeFilterCount(search);

  type SearchPatch = { [K in keyof AlbumsSearch]?: AlbumsSearch[K] | undefined };
  const setSearch = (patch: SearchPatch, keepPage = false) => {
    const next: Record<string, unknown> = { ...search, ...patch };
    if (!keepPage) delete next['page'];
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
    navigate({ to: '/albums', search: next as never });
  };

  // Search box: local echo, URL after a short pause.
  const [q, setQ] = useState(search.q ?? '');
  useEffect(() => { setQ(search.q ?? ''); }, [search.q]);
  useEffect(() => {
    if ((search.q ?? '') === q.trim()) return;
    const t = setTimeout(() => setSearch({ q: q.trim() || undefined }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const filterOptions: AlbumsFilterOptions = {
    offset: (page - 1) * PAGE_SIZE,
    limit: PAGE_SIZE,
    sort,
    ...(query.q && { search: query.q }),
    ...(query.artist && { artist: query.artist }),
    ...(query.state && { filter: query.state }),
    ...(query.decided && { decided: query.decided }),
    ...(query.review && { review: query.review }),
    ...(query.genre && { genre: query.genre }),
    ...(query.decade !== undefined && { decade: query.decade }),
    ...(query.format && { format: query.format }),
    ...(query.label && { label: query.label }),
    ...(query.owned && { owned: query.owned }),
    ...(query.gap && { gap: query.gap }),
  };

  const { data: albumsPage, isLoading, error } = useAlbums(libraryId, filterOptions);
  const { data: facets } = useAlbumFacets(libraryId, query);
  const { data: savedViews } = useSavedViews(libraryId);
  const createView = useCreateSavedView(libraryId);
  const deleteView = useDeleteSavedView(libraryId);
  const [railOpen, setRailOpen] = useState(true);

  if (!libraryId) {
    return <div className={styles.container}>Loading library...</div>;
  }

  const open = (albumId: string) => navigate({ to: `/albums/${albumId}` });
  const clearAll = () => navigate({ to: '/albums', search: { ...(search.sort && { sort: search.sort }), ...(search.view && { view: search.view }) } as never });
  const applyView = (v: SavedView) => navigate({ to: '/albums', search: v.query as never });
  const saveView = () => {
    const name = window.prompt('Name this view', '');
    if (!name?.trim()) return;
    createView.mutate({ name: name.trim(), query: albumsQueryOf(search) });
  };

  const chips = (Object.entries(query) as Array<[keyof typeof query, string | number | undefined]>)
    .filter(([k, v]) => v !== undefined && v !== '' && k !== 'sort' && k !== 'view')
    .map(([k, v]) => ({
      key: k,
      text: `${CHIP_LABEL[k] ?? k}: ${k === 'state' ? STATE_LABEL[String(v)] ?? v : k === 'decade' ? `${v}s` : v}`,
    }));

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
          <select
            className={styles.select}
            value={sort}
            onChange={(e) => setSearch({ sort: e.target.value as AlbumsSearch['sort'] })}
            title="Sort"
          >
            <option value="artist">Artist A–Z</option>
            <option value="title">Title A–Z</option>
            <option value="year">Year, newest</option>
            <option value="added_date">Recently added</option>
            <option value="rating">Your rating</option>
            <option value="listened">Last listened</option>
          </select>
          <div className={styles.viewToggle} role="group" aria-label="View mode">
            <button className={view === 'grid' ? styles.toolButtonActive : styles.toolButton} onClick={() => setSearch({ view: undefined }, true)}>Grid</button>
            <button className={view === 'list' ? styles.toolButtonActive : styles.toolButton} onClick={() => setSearch({ view: 'list' }, true)}>List</button>
          </div>
        </div>
        {chips.length > 0 && (
          <div className={styles.chips}>
            {chips.map((c) => (
              <button key={c.key} className={styles.chip} onClick={() => setSearch({ [c.key]: undefined })} title="Remove filter">
                {c.text} ✕
              </button>
            ))}
            <button className={styles.chipClear} onClick={clearAll}>Clear all</button>
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
            onPatch={(patch) => setSearch(patch as SearchPatch)}
            onClear={clearAll}
            onApplyView={applyView}
            onSaveView={saveView}
            onDeleteView={(id) => { if (window.confirm('Delete this saved view?')) deleteView.mutate(id); }}
          />
        )}

        <div className={styles.main}>
          {isLoading && <div className={styles.loading}>Loading albums...</div>}
          {error && <div className={styles.error}>Failed to load albums</div>}

          {albumsPage && albumsPage.items.length === 0 && (
            <div className={styles.emptyState}>
              <h2>{activeCount > 0 || query.q ? 'No albums match these filters' : 'No albums found'}</h2>
              {activeCount > 0 || query.q
                ? <p><button className={styles.toolButton} onClick={clearAll}>Clear filters</button></p>
                : <p>Start scanning in Settings to build your library.</p>}
            </div>
          )}

          {albumsPage && albumsPage.items.length > 0 && view === 'grid' && (
            <div className={styles.gridContainer}>
              <div className={styles.grid}>
                {albumsPage.items.map((album) => (
                  <div
                    key={album.id}
                    className={styles.albumCard}
                    onClick={() => open(album.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') open(album.id); }}
                  >
                    <div className={styles.albumCover}>
                      {album.needsAttention && <span className={styles.attentionDot} title="Needs attention" />}
                      {album.hasReview && <span className={styles.reviewedDot} title="Reviewed" />}
                      {album.ownRating != null && (
                        <span className={styles.ratingBadge} title={`Your rating: ${album.ownRating}`}>★ {album.ownRating}</span>
                      )}
                      {album.canonicalTrackCount != null && album.trackCount < album.canonicalTrackCount && (
                        <span className={styles.trackBadge}>{album.trackCount}/{album.canonicalTrackCount}</span>
                      )}
                      {album.coverUrl ? (
                        <img className={styles.coverImg} src={album.coverUrl} alt="" loading="lazy" />
                      ) : (
                        <div className={styles.coverPlaceholder}><span className={styles.fileCount}>{album.trackCount}</span></div>
                      )}
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
                ))}
              </div>
            </div>
          )}

          {albumsPage && albumsPage.items.length > 0 && view === 'list' && (
            <div className={styles.gridContainer}>
              <table className={styles.listTable}>
                <thead>
                  <tr>
                    <th></th><th>Title</th><th>Artist</th><th>Year</th><th>Tracks</th><th>Format</th><th>State</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {albumsPage.items.map((album) => (
                    <tr key={album.id} className={styles.listRow} onClick={() => open(album.id)} tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') open(album.id); }}>
                      <td>
                        {album.coverUrl
                          ? <img className={styles.thumb} src={album.coverUrl} alt="" loading="lazy" />
                          : <span className={styles.thumbPlaceholder} />}
                      </td>
                      <td className={styles.listTitle}>{album.title}</td>
                      <td className={styles.listArtist}>{album.artistCredit}</td>
                      <td className={styles.num}>{album.year ?? '–'}</td>
                      <td className={styles.num}>
                        {album.canonicalTrackCount != null && album.trackCount < album.canonicalTrackCount
                          ? <span className={styles.incomplete}>{album.trackCount}/{album.canonicalTrackCount}</span>
                          : album.trackCount}
                      </td>
                      <td><span className={album.isLossless ? styles.formatLossless : album.isMixed ? styles.formatMixed : styles.formatTag}>{formatLabel(album)}</span></td>
                      <td className={styles.listState}>{STATE_LABEL[album.state] ?? album.state}</td>
                      <td className={styles.listBadges}>
                        {album.needsAttention && <span className={styles.inlineDot} title="Needs attention" />}
                        {album.ownRating != null && <span title="Your rating">★ {album.ownRating}</span>}
                        {album.hasReview && <span title="Reviewed">✎</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {albumsPage && (albumsPage.nextCursor || page > 1) && (
            <div className={styles.pagination}>
              <button onClick={() => setSearch({ page: page > 2 ? page - 1 : undefined }, true)} disabled={page === 1}>Previous</button>
              <span className={styles.paginationInfo}>
                {(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + albumsPage.items.length}
                {facets ? ` of ${facets.total.toLocaleString()}` : ''}
              </span>
              <button onClick={() => setSearch({ page: page + 1 }, true)} disabled={!albumsPage.nextCursor}>Next</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
