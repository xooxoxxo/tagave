/**
 * One album of the albums grid: the cover (with its corner marks) over the
 * title, the artist and one stats line. While the album's files are offline
 * the stats line starts with a small "Files offline" tag (for everyone);
 * the cover still shows. Fixed height: the grid's virtualizer uses one row
 * height, so the tag sits inside the stats line instead of adding one.
 */
import type { HTMLAttributes, MouseEvent, ReactNode } from 'react';
import type { AlbumSummary } from '@tagave/shared';
import { Badge, CoverArt } from '../components/ui';
import styles from './AlbumsPage.module.css';

/** How a match was decided, in words (Maintenance only); the title says more. */
const KIND_TAG: Record<string, { text: string; title: string }> = {
  chip_rule: { text: 'by rule', title: 'Matched by one of your matching rules' },
  first_candidate: { text: 'first pick', title: 'Matched to the closest candidate without a clear winner' },
  by_me: { text: 'by you', title: 'You chose this match' },
  manual_mbid: { text: 'by link', title: 'Matched from a release link you pasted' },
  model: { text: 'model', title: 'Matched by a decision model' },
};

export function formatLabel(a: AlbumSummary): string {
  if (a.isLossless) return 'Lossless';
  if (a.isMixed) return 'Mixed';
  return (a.formats[0] ?? '').toUpperCase();
}

/** "Files offline": the small tag the grid tile and the list row carry while the album's music folder is offline (all or some of its files). */
export function OfflineTag({ filesOffline, className }: { filesOffline: AlbumSummary['filesOffline'] | undefined; className?: string | undefined }) {
  if (filesOffline !== 'all' && filesOffline !== 'some') return null;
  return <Badge size="sm" tone="warning" className={className ?? ''}>Files offline</Badge>;
}

export interface AlbumGridCardProps {
  album: AlbumSummary;
  /** the card's width, and its padding (the cover is the width less twice that) */
  width: number;
  pad: number;
  /** a phone's grid: tighter cards */
  narrow: boolean;
  selected: boolean;
  maintenance: boolean;
  /** the red dot: needs attention (Maintenance) or needs your review */
  attention: boolean;
  /** the selection checkbox in the cover's corner; absent for a role that can't select */
  check?: { onClick: (e: MouseEvent) => void; onChange: () => void } | null | undefined;
  /** the ⋮ at the end of the title line */
  more?: ReactNode;
  /** the title keeps room for the ⋮ */
  moreRoom?: boolean | undefined;
  /** the card's own handlers (open, keys, long press) */
  rootProps?: HTMLAttributes<HTMLDivElement> | undefined;
}

export function AlbumGridCard({ album, width, pad, narrow, selected, maintenance, attention, check = null, more = null, moreRoom = false, rootProps }: AlbumGridCardProps) {
  return (
    <div
      className={selected ? styles.albumCardSelected : styles.albumCard}
      style={narrow ? { width, padding: pad, gap: 10 } : { width }}
      role="button"
      tabIndex={0}
      aria-label={`${album.title}, ${album.artistCredit}`}
      {...rootProps}
    >
      <div className={styles.albumCover} style={{ height: width - 2 * pad }}>
        {check && <label className={selected ? styles.cardCheckOn : styles.cardCheck} onClick={check.onClick}>
          <input
            type="checkbox"
            className={styles.cardCheckbox}
            checked={selected}
            onChange={check.onChange}
            aria-label={`Select ${album.title}`}
          />
        </label>}
        {attention && <span className={styles.attentionDot} title={maintenance ? 'Needs attention' : 'Needs your review'} />}
        {album.hasReview && <span className={styles.reviewedDot} title="Reviewed" />}
        {album.ownRating != null && (
          <span className={styles.ratingBadge} title={`Your rating: ${album.ownRating}`}>★ {album.ownRating}</span>
        )}
        {maintenance && album.canonicalTrackCount != null && album.trackCount < album.canonicalTrackCount && (
          <span className={styles.trackBadge}>{album.trackCount}/{album.canonicalTrackCount}</span>
        )}
        <CoverArt src={album.coverUrl} title={album.title} fill />
      </div>
      <div className={moreRoom ? styles.albumInfoMore : styles.albumInfo}>
        {more}
        <h3 className={styles.albumTitle} dir="auto">{album.title}</h3>
        <p className={styles.albumArtist} dir="auto">{album.artistCredit}</p>
        <p className={styles.albumStats}>
          <OfflineTag filesOffline={album.filesOffline} className={styles.offlineTag} />
          <span className={album.isLossless ? styles.formatLossless : album.isMixed ? styles.formatMixed : styles.formatTag}>{formatLabel(album)}</span>
          {' · '}{album.trackCount} {album.trackCount === 1 ? 'track' : 'tracks'}
          {album.year ? ` · ${album.year}` : ''}
          {maintenance && album.matchKind && album.matchKind !== 'auto_strong' && (
            KIND_TAG[album.matchKind] && <span className={styles.kindTag} title={KIND_TAG[album.matchKind]!.title}> · {KIND_TAG[album.matchKind]!.text}</span>
          )}
        </p>
      </div>
    </div>
  );
}
