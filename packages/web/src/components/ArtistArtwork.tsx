/**
 * An artist's picture in the artists browser: a mosaic of up to four of their
 * album covers, or a quiet initials tile when none has a cover. Decorative:
 * the name next to it is the accessible label.
 */
import { artistInitials, isSymbolOnlyName } from '@liner/shared';
import { mosaicCovers, IDENTITY_HINT } from '../pages/artistsView';
import styles from './ArtistArtwork.module.css';

const coverUrl = (albumId: string) => `/api/v1/images/album/${albumId}`;

/** A stable 0–2 from the name, so neighbouring initials tiles are not all one tone. */
export function toneOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 3;
}

export function ArtistArtwork({ name, coverAlbumIds, compact = false }: {
  name: string;
  coverAlbumIds?: string[] | undefined;
  /** a small list thumbnail instead of a card picture */
  compact?: boolean;
}) {
  const covers = mosaicCovers(coverAlbumIds);
  const shape = compact ? styles.thumb : styles.art;
  if (covers.length === 0) {
    return <span className={`${shape} ${styles.initials} ${isSymbolOnlyName(name) ? styles.symbolic : ''}`} data-tone={toneOf(name)} aria-hidden="true">
      <span>{artistInitials(name)}</span>
    </span>;
  }
  // a list thumbnail is too small for a mosaic: the first cover alone
  const shown = compact ? covers.slice(0, 1) : covers;
  return <span className={`${shape} ${styles.mosaic}`} data-count={shown.length} aria-hidden="true">
    {shown.map((id) => <img key={id} src={coverUrl(id)} alt="" loading="lazy" decoding="async" />)}
  </span>;
}

/**
 * Linked (a canonical, identified artist) or local-only (a name from tags):
 * a tiny mark with a native tooltip and a screen-reader label, never a sentence.
 */
export function IdentityMark({ resolved }: { resolved: boolean }) {
  const hint = resolved ? IDENTITY_HINT.linked : IDENTITY_HINT.local;
  return <span className={resolved ? styles.linked : styles.local} title={hint}>
    {resolved
      ? <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" /><path d="M5 8.2l2 2 4-4.4" /></svg>
      : <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /></svg>}
    <span className="visually-hidden">{resolved ? 'Identified artist' : 'From tags only'}</span>
  </span>;
}
