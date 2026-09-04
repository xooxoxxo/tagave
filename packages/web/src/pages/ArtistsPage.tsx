/**
 * Artists browse view (spec BRW-5, M0 grade: derived from local clusters).
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCurrentLibrary } from '../hooks';
import { api } from '../services/api';
import styles from './ArtistsPage.module.css';

interface ArtistRow {
  name: string;
  albumCount: number;
  trackCount: number;
  yearFrom: number | null;
  yearTo: number | null;
}

function useArtists(libraryId: string | undefined, search: string, offset: number) {
  return useQuery({
    queryKey: ['artists', libraryId, search, offset],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100', offset: String(offset) });
      if (search) params.set('search', search);
      return api.get<{ items: ArtistRow[]; nextCursor: string | null }>(
        `/libraries/${libraryId}/artists?${params}`,
      );
    },
    enabled: !!libraryId,
    staleTime: 60_000,
  });
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
            {data.items.map((artist) => (
              <div
                key={artist.name}
                className={styles.row}
                role="button"
                tabIndex={0}
                onClick={() =>
                  navigate({ to: '/albums', search: { artist: artist.name } as never })
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    navigate({ to: '/albums', search: { artist: artist.name } as never });
                  }
                }}
              >
                <span className={styles.name}>{artist.name}</span>
                <span className={styles.meta}>
                  {artist.albumCount} albums · {artist.trackCount} tracks
                  {artist.yearFrom
                    ? ` · ${artist.yearFrom}${artist.yearTo && artist.yearTo !== artist.yearFrom ? `–${artist.yearTo}` : ''}`
                    : ''}
                </span>
              </div>
            ))}
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
