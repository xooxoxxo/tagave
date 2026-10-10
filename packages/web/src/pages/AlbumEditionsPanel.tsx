/**
 * The album page's Editions tab. Editions we already hold for the release
 * group (from identification or an earlier fetch) show at once; fetching from
 * MusicBrainz only completes the list. The heading count is the number of rows
 * shown, so the two always agree.
 */
import { Fragment, type ReactNode } from 'react';
import type { Edition, EditionsData } from '../hooks';
import { Button } from '../components/ui';
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
  /** the last cell of each row: the "Your copy" chip or the switch button */
  rowAction: (edition: Edition) => ReactNode;
  /** a line under a row, across the whole table (a failed switch says why) */
  rowNote?: (edition: Edition) => ReactNode;
  footer?: ReactNode;
}

export function AlbumEditionsPanel({ hasReleaseGroup, editions, onFetch, fetchPending, tools, rowAction, rowNote, footer }: AlbumEditionsPanelProps) {
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
            <Button
              variant="quiet"
              size="sm"
              onClick={onFetch}
              disabled={fetchPending}
              title={`Fetched ${new Date(editions.fetchedAt).toLocaleString()} — fetch again from MusicBrainz`}
            >
              Refresh
            </Button>
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
            <Button variant="quiet" size="sm" onClick={onFetch} disabled={fetchPending}>
              {fetchPending ? 'Queuing…' : 'Fetch editions from MusicBrainz'}
            </Button>
          </p>
        )
      ) : (<>
        {!fetched && !fetching && (
          <p className={styles.muted}>
            Showing {rows.length} edition{rows.length === 1 ? '' : 's'} we know about.{' '}
            <Button variant="quiet" size="sm" onClick={onFetch} disabled={fetchPending}>
              {fetchPending ? 'Queuing…' : 'Fetch the full list from MusicBrainz'}
            </Button>
          </p>
        )}
        <table className={`${styles.candTable} ${styles.editionsTable}`}>
          <thead>
            <tr>
              <th className={styles.editionDate}>Date</th>
              <th>Country</th>
              <th>Label / Catno</th>
              <th>Format</th>
              <th className={styles.num}>Tracks</th>
              <th className={styles.editionAction}><span className={styles.srOnly}>Action</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const note = rowNote?.(e);
              return (<Fragment key={e.releaseId}>
              <tr className={[e.owned ? styles.ownedRow : '', note ? styles.editionHasNote : ''].filter(Boolean).join(' ') || undefined} aria-current={e.owned ? 'true' : undefined}>
                <td className={`${styles.num} ${styles.editionDate}`} data-label="Date">{e.date ?? '–'}</td>
                <td data-label="Country">{e.country ?? '–'}</td>
                <td data-label="Label">
                  {/* one wrapper, so the phone layout's label sits beside all the lines */}
                  <span>
                    {e.labels.length > 0
                      ? e.labels.map((l) => (
                        <span key={l.name} className={styles.cellLine}>
                          {l.name}
                          {l.catalogNumber && ` / ${l.catalogNumber}`}
                        </span>
                      ))
                      : '–'}
                  </span>
                </td>
                <td data-label="Format">
                  <span>
                    {e.media.map((m, i) => (
                      <span key={i} className={styles.cellLine}>
                        {m.format}
                        {m.trackCount ? ` × ${m.trackCount}` : ''}
                      </span>
                    ))}
                  </span>
                </td>
                <td className={styles.num} data-label="Tracks">{e.trackCount}</td>
                {/* a block inside the cell: a flex <td> stops being a table cell,
                    and the row's tint and baseline broke at that column */}
                <td className={styles.editionAction}><div className={styles.editionActionInner}>{rowAction(e)}</div></td>
              </tr>
              {note && (
                <tr className={`${styles.editionNoteRow}${e.owned ? ` ${styles.ownedRow}` : ''}`}>
                  <td colSpan={6}>{note}</td>
                </tr>
              )}
              </Fragment>);
            })}
          </tbody>
        </table>
        {footer}
      </>)}
    </div>
  );
}
