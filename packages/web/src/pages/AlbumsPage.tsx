/**
 * Album grid page showing virtualized list of albums
 * M0: Observed data only (no identification yet)
 */

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useCurrentLibrary, useAlbums } from '../hooks';
import { AlbumsFilterOptions } from '../hooks/useLibrary';
import styles from './AlbumsPage.module.css';

export function AlbumsPage() {
  const artistFilter = new URLSearchParams(window.location.search).get('artist') ?? undefined;
  const navigate = useNavigate();
  const { libraryId } = useCurrentLibrary();

  const [searchQuery, setSearchQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [limit] = useState(50);
  const [sort, setSort] = useState<'artist' | 'title' | 'year' | 'added_date'>('artist');
  const [stateFilter, setStateFilter] = useState('all');
  const [decided, setDecided] = useState('all');

  const filterOptions: AlbumsFilterOptions = {
    offset,
    limit,
    ...(searchQuery && { search: searchQuery }),
    ...(artistFilter && { artist: artistFilter }),
    ...(stateFilter !== 'all' && { filter: stateFilter }),
    ...(decided !== 'all' && { decided }),
    sort,
  };

  const { data: albumsPage, isLoading, error } = useAlbums(libraryId, filterOptions);

  if (!libraryId) {
    return <div className={styles.container}>Loading library...</div>;
  }

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setOffset(0); // Reset to first page on search
  };

  const handleAlbumClick = (albumId: string) => {
    navigate({ to: `/albums/${albumId}` });
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>Albums</h1>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search albums, artists..."
          value={searchQuery}
          onChange={handleSearch}
        />
        <select
          className={styles.select}
          value={sort}
          onChange={(e) => { setSort(e.target.value as typeof sort); setOffset(0); }}
        >
          <option value="artist">Artist A–Z</option>
          <option value="title">Title A–Z</option>
          <option value="year">Year, newest</option>
          <option value="added_date">Recently added</option>
        </select>
        <select
          className={styles.select}
          value={stateFilter}
          onChange={(e) => { setStateFilter(e.target.value); setOffset(0); }}
        >
          <option value="all">All states</option>
          <option value="matched">Matched</option>
          <option value="needs_review">Needs review</option>
          <option value="unidentified">Unidentified</option>
          <option value="as_is">Kept as-is</option>
        </select>
        <select
          className={styles.select}
          value={decided}
          onChange={(e) => { setDecided(e.target.value); setOffset(0); }}
          title="How the match was decided"
        >
          <option value="all">Any match kind</option>
          <option value="auto_strong">Auto (strong)</option>
          <option value="chip_rule">Auto (chip rule)</option>
          <option value="first_candidate">Auto (first candidate)</option>
          <option value="by_me">Accepted by me</option>
          <option value="manual_mbid">Manual MBID</option>
        </select>
      </header>

      {isLoading && <div className={styles.loading}>Loading albums...</div>}

      {error && (
        <div className={styles.error}>
          Failed to load albums
        </div>
      )}

      {albumsPage && albumsPage.items.length === 0 && (
        <div className={styles.emptyState}>
          <h2>No albums found</h2>
          <p>Start scanning in Settings to build your library.</p>
        </div>
      )}

      {albumsPage && albumsPage.items.length > 0 && (
        <>
          <div className={styles.gridContainer}>
            <div className={styles.grid}>
              {albumsPage.items.map((album) => (
                <div
                  key={album.id}
                  className={styles.albumCard}
                  onClick={() => handleAlbumClick(album.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      handleAlbumClick(album.id);
                    }
                  }}
                >
                  <div className={styles.albumCover}>
                    {album.needsAttention && (
                      <span className={styles.attentionDot} title="Needs attention" />
                    )}
                    {album.canonicalTrackCount != null &&
                      album.trackCount < album.canonicalTrackCount && (
                        <span className={styles.trackBadge}>
                          {album.trackCount}/{album.canonicalTrackCount}
                        </span>
                      )}
                    {album.coverUrl ? (
                      <img
                        className={styles.coverImg}
                        src={album.coverUrl}
                        alt=""
                        loading="lazy"
                      />
                    ) : (
                      <div className={styles.coverPlaceholder}>
                        <span className={styles.fileCount}>{album.trackCount}</span>
                      </div>
                    )}
                  </div>
                  <div className={styles.albumInfo}>
                    <h3 className={styles.albumTitle}>{album.title}</h3>
                    <p className={styles.albumArtist}>
                      {album.artistCredit}
                    </p>
                    <p className={styles.albumStats}>
                      {album.trackCount} tracks
                      {album.matchKind && album.matchKind !== 'auto_strong' && (
                        <span className={styles.kindTag}>
                          {{ chip_rule: ' · chips', first_candidate: ' · 1st cand', by_me: ' · me', manual_mbid: ' · mbid' }[album.matchKind] ?? ''}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Pagination */}
          {(albumsPage.nextCursor || offset > 0) && (
            <div className={styles.pagination}>
              <button
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0}
              >
                Previous
              </button>
              <span className={styles.paginationInfo}>
                {offset + 1}–{offset + albumsPage.items.length}
              </span>
              <button
                onClick={() => setOffset(offset + limit)}
                disabled={!albumsPage.nextCursor}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
