/**
 * The comparison tables: possible releases for an album that needs a match,
 * and your files against the matched edition track by track. These are the
 * only places a length difference between the release and your files shows,
 * and only a difference beyond LENGTH_TOLERANCE_MS is marked.
 */
import { Button } from '../components/ui';
import { formatDelta, lengthDiscrepancy, LENGTH_TOLERANCE_MS } from '../utils/albumAttention';
import type { Candidate, DetailTrack } from './albumDetailTypes';
import { dur } from './albumFormat';
import styles from './AlbumDetailPage.module.css';

export interface CandidateTableProps {
  candidates: Candidate[];
  /** your track count, to mark releases with more or fewer tracks */
  localTrackCount: number | null;
  showExcluded: boolean;
  onToggleExcluded: () => void;
  onAccept: (id: string) => void;
  onExclude: (id: string) => void;
  busy: boolean;
}

export function CandidateTable({ candidates, localTrackCount, showExcluded, onToggleExcluded, onAccept, onExclude, busy }: CandidateTableProps) {
  const visible = candidates.filter((c) => showExcluded || !c.excluded).sort((a, b) => a.distance - b.distance);
  const excluded = candidates.filter((c) => c.excluded).length;
  if (candidates.length === 0) return <p className={styles.muted}>No possible releases were found. Paste the release below if you know it.</p>;
  return (
    <div className={styles.matchBlock}>
      <div className={styles.trackScroller}>
        <table className={styles.candTable}>
          {/* fixed columns: only Release flexes, so accepting or excluding a
              candidate never re-flows the others */}
          <colgroup>
            <col />
            <col className={styles.candWDate} />
            <col className={styles.candWCountry} />
            <col className={styles.candWTracks} />
            <col className={styles.candWActions} />
          </colgroup>
          <thead>
            <tr>
              <th>Release</th>
              <th>Date</th>
              <th>Country</th>
              <th className={styles.num}>Tracks</th>
              <th><span className={styles.srOnly}>Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => {
              const trackOff = c.trackCount != null && localTrackCount != null && c.trackCount !== localTrackCount;
              return (
                <tr key={c.id} className={c.excluded ? styles.candExcluded : ''}>
                  <td className={styles.candRelease}>
                    <div className={styles.candTitleRow}>
                      <span className={styles.candTitle}>{c.title}</span>
                      <span className={styles.candArtist}>{c.artistCredit}</span>
                    </div>
                    <div className={styles.candSub}>
                      <span title={`Found via ${c.source.replace(/_/g, ' ')} · distance ${c.distance.toFixed(4)} (0 = identical to your tags and lengths)`}>
                        {c.provider === 'discogs' ? 'Discogs' : 'MusicBrainz'}
                      </span>
                      {[c.format, c.label, c.status].filter(Boolean).map((x) => <span key={String(x)}>{x}</span>)}
                      {c.releaseMbid && (
                        <a className={styles.pillLink} href={`https://musicbrainz.org/release/${c.releaseMbid}`} target="_blank" rel="noreferrer">MusicBrainz ↗</a>
                      )}
                      {c.discogsReleaseId && (
                        <a className={styles.pillLink} href={`https://www.discogs.com/release/${c.discogsReleaseId}`} target="_blank" rel="noreferrer">Discogs ↗</a>
                      )}
                    </div>
                  </td>
                  <td className={styles.num}>{c.date ?? '–'}</td>
                  <td>{c.country ?? '–'}</td>
                  <td className={`${styles.num} ${trackOff ? styles.cellOff : ''}`} data-suffix=" tracks" title={trackOff ? `You have ${localTrackCount}` : undefined}>
                    {c.trackCount ?? '–'}
                    {trackOff && <span className={styles.srOnly}> (you have {localTrackCount})</span>}
                  </td>
                  <td className={styles.candActions}>
                    {!c.excluded && (
                      <>
                        <Button variant="secondary" size="sm" onClick={() => onAccept(c.id)} disabled={busy} title="Match this album to this release">Accept</Button>
                        <Button variant="quiet" size="sm" onClick={() => onExclude(c.id)} disabled={busy} title="Never suggest this release again">Exclude</Button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {excluded > 0 && (
        <Button variant="quiet" size="sm" onClick={onToggleExcluded}>
          {showExcluded ? 'Hide' : 'Show'} {excluded} excluded
        </Button>
      )}
    </div>
  );
}

/** Your files against the matched edition. Differences beyond the tolerance are marked. */
export function TrackComparison({ tracks, onlyDifferences = false }: { tracks: DetailTrack[]; onlyDifferences?: boolean }) {
  const rows = tracks.filter((t) => t.canonicalDurationMs || t.canonicalTitle);
  const shown = onlyDifferences
    ? rows.filter((t) => lengthDiscrepancy(t.durationMs, t.canonicalDurationMs) !== null)
    : rows;
  if (shown.length === 0) return null;
  return (
    <div className={styles.trackScroller}>
      <table className={styles.compareTable}>
        <caption className={styles.srOnly}>Your files compared with the matched edition; lengths more than {LENGTH_TOLERANCE_MS / 1000} seconds apart are marked</caption>
        <thead>
          <tr>
            <th className={styles.num}>#</th>
            <th>Title</th>
            <th className={styles.num}>Yours</th>
            <th className={styles.num}>Release</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((t) => {
            const d = lengthDiscrepancy(t.durationMs, t.canonicalDurationMs);
            const titleDiffers = !!t.canonicalTitle && !!t.title && t.canonicalTitle.trim().toLowerCase() !== t.title.trim().toLowerCase();
            return (
              <tr key={t.id}>
                <td className={styles.num}>{(t.discNo ?? 1) > 1 ? `${t.discNo}-` : ''}{t.trackNo ?? '–'}</td>
                <td className={styles.compareTitle}>
                  {t.title ?? '(untitled)'}
                  {titleDiffers && <span className={styles.compareSub}>Release: {t.canonicalTitle}</span>}
                </td>
                <td className={`${styles.num} ${d !== null ? styles.cellOff : ''}`}>
                  {dur(t.durationMs)}
                  {d !== null && <span className={styles.delta}> {formatDelta(d)}</span>}
                </td>
                <td className={styles.num}>{dur(t.canonicalDurationMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
