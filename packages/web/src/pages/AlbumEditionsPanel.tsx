/**
 * The album page's Editions tab. Editions we already hold for the release
 * group (from identification or an earlier fetch) show at once; fetching from
 * MusicBrainz only completes the list. The heading count is the number of rows
 * shown, so the two always agree.
 */
import type { ReactNode } from 'react';
import type { Edition, EditionsData } from '../hooks';
import styles from './AlbumDetailPage.module.css';

export interface AlbumEditionsPanelProps {
  /** the album is matched to a release group */
  hasReleaseGroup: boolean;
  /** undefined while the query loads */
  editions: EditionsData | undefined;
  onFetch: () => void;
  fetchPending: boolean;
  /** page-specific items for the header (any-edition pill, pending switch, errors) */
  tools?: ReactNode;
  /** the last cell of each row: "This copy" or the switch button */
  rowAction: (edition: Edition) => ReactNode;
  footer?: ReactNode;
}

export function AlbumEditionsPanel({ hasReleaseGroup, editions, onFetch, fetchPending, tools, rowAction, footer }: AlbumEditionsPanelProps) {
  const rows = editions?.editions ?? [];
  const fetched = !!editions?.fetchedAt;
  const fetching = !!editions?.fetching;

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Editions{rows.length > 0 ? ` (${rows.length})` : ''}</h2>
        <div className={styles.sectionTools}>
          {tools}
          {fetching && rows.length > 0 && (
            <span className={styles.muted}>Fetching editions from MusicBrainz…</span>
          )}
          {editions?.fetchedAt && !fetching && (
            <button
              className={styles.linkButton}
              onClick={onFetch}
              disabled={fetchPending}
              title={`Fetched ${new Date(editions.fetchedAt).toLocaleString()} — fetch again from MusicBrainz`}
            >
              Refresh
            </button>
          )}
        </div>
      </div>
      {!hasReleaseGroup ? (
        <p className={styles.muted}>Editions belong to a release group — match this album first.</p>
      ) : !editions ? (
        <p className={styles.muted}>Loading…</p>
      ) : rows.length === 0 ? (
        fetching ? (
          <p className={styles.muted}>Fetching editions from MusicBrainz…</p>
        ) : fetched ? (
          <p className={styles.muted}>MusicBrainz lists no other editions for this release group.</p>
        ) : (
          <p className={styles.muted}>
            We don't know of any editions yet.{' '}
            <button className={styles.linkButton} onClick={onFetch} disabled={fetchPending}>
              {fetchPending ? 'Queuing…' : 'Fetch editions from MusicBrainz'}
            </button>
          </p>
        )
      ) : (<>
        {!fetched && !fetching && (
          <p className={styles.muted}>
            Showing {rows.length} edition{rows.length === 1 ? '' : 's'} we know about.{' '}
            <button className={styles.linkButton} onClick={onFetch} disabled={fetchPending}>
              {fetchPending ? 'Queuing…' : 'Fetch the full list from MusicBrainz'}
            </button>
          </p>
        )}
        <table className={styles.candTable}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Country</th>
              <th>Label / Catno</th>
              <th>Format</th>
              <th className={styles.num}>Tracks</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.releaseId} className={e.owned ? styles.ownedRow : ''}>
                <td className={styles.num}>{e.date ?? '–'}</td>
                <td>{e.country ?? '–'}</td>
                <td>
                  {e.labels.length > 0
                    ? e.labels.map((l) => (
                      <span key={l.name} className={styles.cellLine}>
                        {l.name}
                        {l.catalogNumber && ` / ${l.catalogNumber}`}
                      </span>
                    ))
                    : '–'}
                </td>
                <td>
                  {e.media.map((m, i) => (
                    <span key={i} className={styles.cellLine}>
                      {m.format}
                      {m.trackCount ? ` × ${m.trackCount}` : ''}
                    </span>
                  ))}
                </td>
                <td className={styles.num}>{e.trackCount}</td>
                <td className={styles.gapActions}>{rowAction(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {footer}
      </>)}
    </div>
  );
}
