import { Input } from '../components/ui/FormControl';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useArtistsList, useCurrentLibrary } from '../hooks';
import { PageShell, Table, Th, Td, Button, EmptyState } from '../components/ui';
import styles from './ArtistsPage.module.css';

export function ArtistsPage() {
  const { libraryId } = useCurrentLibrary();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, isLoading, error, refetch } = useArtistsList(libraryId, { search, offset, limit: 100 });

  return (
    <PageShell title="Artists" subtitle="Browse artists in your local library. Identified artists also have a profile and discography.">
      <div className={styles.toolbar}>
        <Input className={styles.searchInput} aria-label="Search artists" placeholder="Search artists…" value={search}
          onChange={e => { setSearch(e.target.value); setOffset(0); }} />
        {search && <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setOffset(0); }}>Clear search</Button>}
        {data && <span className={styles.resultCount}>{data.items.length ? `${offset + 1}–${offset + data.items.length}${data.nextCursor ? '' : ` of ${offset + data.items.length}`}` : '0'} artists{search ? ' matching your search' : ''}</span>}
      </div>
      {isLoading && <div className={styles.loading} role="status">Loading artists…</div>}
      {error && <div className={styles.error} role="alert">Couldn’t load artists. <Button variant="secondary" size="sm" onClick={() => void refetch()}>Try again</Button></div>}
      {data && !data.items.length && <EmptyState title={search ? 'No matching artists' : 'No artists in your library yet'} text={search ? 'Try another name or clear your search.' : 'Scan a music folder to build your artist library.'} />}
      {data && data.items.length > 0 && <div className={styles.content}>
        <Table>
          <thead><tr><Th>Artist</Th><Th className={styles.headerAlignRight}>Albums</Th><Th className={styles.headerAlignRight}>Tracks</Th><Th>Release years</Th><Th>Artist information</Th></tr></thead>
          <tbody>{data.items.map(artist => {
            const resolved = artist.id !== null && artist.resolved;
            const years = artist.yearFrom ? `${artist.yearFrom}${artist.yearTo && artist.yearTo !== artist.yearFrom ? `–${artist.yearTo}` : ''}` : 'Not available';
            return <tr key={artist.id ?? artist.name}>
              <Td>{resolved ? <Link className={styles.artistLink} to="/artists/$artistId" params={{ artistId: artist.id! }}>{artist.name}</Link> : <Link className={styles.artistLink} to="/albums" search={{ artist: artist.name }}>{artist.name}</Link>}</Td>
              <Td className={styles.numericCell}>{artist.albumCount.toLocaleString()}</Td>
              <Td className={styles.numericCell}>{artist.trackCount.toLocaleString()}</Td>
              <Td>{years}</Td>
              <Td><span className={styles.artistStatus}>{resolved ? 'Profile & discography' : 'Local tags only'}</span>{!resolved && <span className={styles.statusHint}>Opens albums; artist identity not linked yet</span>}</Td>
            </tr>;
          })}</tbody>
        </Table>
        {(offset > 0 || data.nextCursor) && <div className={styles.pagination}>
          <Button variant="secondary" size="sm" onClick={() => setOffset(Math.max(0, offset - 100))} disabled={offset === 0}>Previous artists</Button>
          <span className={styles.pageInfo}>{offset + 1}–{offset + data.items.length}</span>
          <Button variant="secondary" size="sm" onClick={() => setOffset(offset + 100)} disabled={!data.nextCursor}>Next artists</Button>
        </div>}
      </div>}
    </PageShell>
  );
}
