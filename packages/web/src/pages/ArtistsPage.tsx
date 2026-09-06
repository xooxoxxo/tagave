/**
 * Artists browse view (spec BRW-5, M0 grade: derived from local clusters).
 * Resolved artists (with id) navigate to /artists/$artistId; unresolved rows
 * navigate to /albums?artist=name with muted styling and "unresolved" tag.
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useArtistsList, type ArtistListItem } from '../hooks';
import { useCurrentLibrary } from '../hooks';
import styles from './ArtistsPage.module.css';

function useArtists(libraryId: string | undefined, search: string, offset: number) {
  return useArtistsList(libraryId, { search, offset, limit: 100 });
}

export function ArtistsPage() {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, isLoading, error } = useArtists(libraryId, search, offset);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Artists</h1>
        <input
          className={styles.searchInput}
          placeholder="Search artists..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
      </div>

      {isLoading && <div className={styles.loading}>Loading artists...</div>}
      {error && <div className={styles.error}>Failed to load artists</div>}

      {data && data.items.length === 0 && (
        <div className={styles.emptyState}>No artists found.</div>
      )}

      {data && data.items.length > 0 && (
        <>
          <div className={styles.list}>
            {data.items.map((artist) => {
              const isResolved = artist.id !== null && artist.resolved;
              return (
                <div
                  key={artist.id || artist.name}
                  className={`${styles.row} ${!isResolved ? styles.unresolved : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (isResolved) {
                      navigate({ to: `/artists/${artist.id}` });
                    } else {
                      navigate({ to: '/albums', search: { artist: artist.name } as never });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (isResolved) {
                        navigate({ to: `/artists/${artist.id}` });
                      } else {
                        navigate({ to: '/albums', search: { artist: artist.name } as never });
                      }
                    }
                  }}
                >
                  <span className={styles.name}>{artist.name}</span>
                  <span className={styles.meta}>
                    {artist.albumCount} albums · {artist.trackCount} tracks
                    {artist.yearFrom
                      ? ` · ${artist.yearFrom}${artist.yearTo && artist.yearTo !== artist.yearFrom ? `–${artist.yearTo}` : ''}`
                      : ''}
                    {!isResolved && <span className={styles.unresolvedTag}>unresolved</span>}
                  </span>
                </div>
              );
            })}
          </div>
          <div className={styles.pagination}>
            <button onClick={() => setOffset(Math.max(0, offset - 100))} disabled={offset === 0}>
              Previous
            </button>
            <span>{offset + 1}–{offset + data.items.length}</span>
            <button onClick={() => setOffset(offset + 100)} disabled={!data.nextCursor}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
