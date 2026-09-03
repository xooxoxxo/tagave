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
  const navigate = useNavigate();
  const { libraryId } = useCurrentLibrary();

  const [searchQuery, setSearchQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [limit] = useState(50);

  const filterOptions: AlbumsFilterOptions = {
    offset,
    limit,
    ...(searchQuery && { search: searchQuery }),
    sort: 'added',
    order: 'desc',
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
                    {/* TODO: M1+ show actual cover art */}
                    <div className={styles.coverPlaceholder}>
                      <span className={styles.fileCount}>{album.trackCount}</span>
                    </div>
                  </div>
                  <div className={styles.albumInfo}>
                    <h3 className={styles.albumTitle}>{album.title}</h3>
                    <p className={styles.albumArtist}>
                      {album.artistCredit}
                    </p>
                    <p className={styles.albumStats}>
                      {album.trackCount} tracks
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
