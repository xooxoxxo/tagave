/**
 * Artists browse view (spec BRW-5, M0 grade: derived from local clusters).
 * Resolved artists (with id) navigate to /artists/$artistId; unresolved rows
 * navigate to /albums?artist=name with quiet neutral badge indicating no MusicBrainz id.
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useArtistsList, type ArtistListItem } from '../hooks';
import { useCurrentLibrary } from '../hooks';
import { PageShell, Table, Th, Td, TableRow, Badge, Button, EmptyState } from '../components/ui';
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

  const tabItems = [
    { label: 'Albums', value: 'albums', onClick: () => navigate({ to: '/albums' }) },
    { label: 'Artists', value: 'artists', onClick: () => navigate({ to: '/artists' }) },
  ];

  return (
    <PageShell
      title="Library"
      tabs={tabItems}
      activeTab="artists"
      actions={
        <input
          className={styles.searchInput}
          placeholder="Search artists..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
      }
    >
      {isLoading && <div className={styles.loading}>Loading artists...</div>}
      {error && <div className={styles.error}>Failed to load artists</div>}

      {data && data.items.length === 0 && (
        <EmptyState title="No artists found" text={search ? 'Try adjusting your search.' : ''} />
      )}

      {data && data.items.length > 0 && (
        <div className={styles.content}>
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th className={styles.headerAlignRight}>Albums</Th>
                <Th className={styles.headerAlignRight}>Tracks</Th>
                <Th>Years</Th>
                <Th className={styles.headerAlignRight}></Th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((artist) => {
                const isResolved = artist.id !== null && artist.resolved;
                const yearRange = artist.yearFrom
                  ? `${artist.yearFrom}${artist.yearTo && artist.yearTo !== artist.yearFrom ? `–${artist.yearTo}` : ''}`
                  : '';

                const rowContent = (
                  <>
                    <Td className={!isResolved ? styles.unresolvedName : ''}>
                      {artist.name}
                    </Td>
                    <Td className={styles.numericCell}>
                      {artist.albumCount}
                    </Td>
                    <Td className={styles.numericCell}>
                      {artist.trackCount}
                    </Td>
                    <Td>{yearRange}</Td>
                    <Td className={styles.badgeCell}>
                      {!isResolved && (
                        <Badge tone="neutral">No MusicBrainz ID</Badge>
                      )}
                    </Td>
                  </>
                );

                if (isResolved) {
                  return (
                    <TableRow key={artist.id || artist.name} to={`/artists/${artist.id}`}>
                      {rowContent}
                    </TableRow>
                  );
                }

                return (
                  <TableRow
                    key={artist.name}
                    onClick={() => navigate({ to: '/albums', search: { artist: artist.name } as never })}
                  >
                    {rowContent}
                  </TableRow>
                );
              })}
            </tbody>
          </Table>

          <div className={styles.pagination}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOffset(Math.max(0, offset - 100))}
              disabled={offset === 0}
            >
              Previous
            </Button>
            <span className={styles.pageInfo}>
              {offset + 1}–{offset + data.items.length}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOffset(offset + 100)}
              disabled={!data.nextCursor}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </PageShell>
  );
}
