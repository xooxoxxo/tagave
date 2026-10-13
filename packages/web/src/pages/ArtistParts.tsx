/**
 * Pieces both artist page layouts share: the album card and grid, the
 * follow button, the details note (fetching, failed), the biography and the
 * Maintenance tools.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, CoverArt, CoverChip, IconButton, UndoIcon, type CoverChipTone } from '../components/ui';
import type { ArtistAlbum, ArtistAlbumOwnership, ArtistDetail } from '../hooks';
import { paragraphs, shortDate, type DetailsState } from './artistPageView';
import styles from './ArtistPage.module.css';

const CHIP: Partial<Record<ArtistAlbumOwnership, [string, CoverChipTone]>> = {
  physical: ['Physical', 'neutral'],
  both: ['Digital & Physical', 'accent'],
  missing: ['Missing', 'warn'],
  ignored: ['Skipped', 'neutral'],
};

export function AlbumCard({ album, onReopen, reopening }: {
  album: ArtistAlbum;
  /** a skipped release: bring it back to the missing list */
  onReopen?: ((gapId: string) => void) | undefined;
  reopening?: boolean;
}) {
  const away = album.ownership === 'missing' || album.ownership === 'ignored';
  const chip = CHIP[album.ownership];
  const cover = (
    <CoverArt src={album.coverUrl} title={album.title} dimmed={away ? (album.ownership as 'missing' | 'ignored') : undefined} interactive={!!album.localAlbumId}>
      {chip && <CoverChip tone={chip[1]}>{chip[0]}</CoverChip>}
      {album.ownership === 'ignored' && album.gapId && onReopen && (
        <IconButton
          size="sm"
          label={`Back to missing (skipped${album.dismissReason ? `: ${album.dismissReason}` : ''})`}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onReopen(album.gapId!); }}
          disabled={reopening}
          className={styles.reopen}
        >
          <UndoIcon />
        </IconButton>
      )}
    </CoverArt>
  );
  const text = <>
    <h3 className={styles.cardTitle} dir="auto">{album.title}</h3>
    {album.year !== null && <p className={styles.cardMeta}>{album.year}</p>}
  </>;
  if (album.localAlbumId) {
    return <li className={styles.card}>
      <Link to="/albums/$albumId" params={{ albumId: album.localAlbumId }} className={styles.cardLink}>{cover}{text}</Link>
    </li>;
  }
  return <li className={`${styles.card} ${away ? styles.cardAway : ''}`}>{cover}{text}</li>;
}

export function AlbumGrid({ albums, onReopen, reopening }: { albums: ArtistAlbum[]; onReopen?: (gapId: string) => void; reopening?: boolean }) {
  return <ul className={styles.grid}>
    {albums.map((a) => <AlbumCard key={a.key} album={a} onReopen={onReopen} reopening={!!reopening} />)}
  </ul>;
}

export function SkeletonGrid({ n }: { n: number }) {
  return <ul className={styles.grid} aria-hidden="true">
    {Array.from({ length: n }, (_, i) => <li key={i} className={styles.card}><div className={styles.skelCover} /></li>)}
  </ul>;
}

/** A soft bar where text will land while the page loads. */
export function Bar({ width, height, className }: { width?: number | string; height?: number; className?: string | undefined }) {
  return <span className={`${styles.bar} ${className ?? ''}`} style={{ width, height }} aria-hidden="true" />;
}

export function FollowButton({ followed, pending, onToggle }: { followed: boolean; pending: boolean; onToggle: () => void }) {
  return followed
    ? <Button variant="secondary" size="sm" className={styles.followBtn} onClick={onToggle} disabled={pending} aria-pressed="true">
      <svg className={styles.tick} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 10.5 3.2 3L15 6.5" /></svg>
      Following
    </Button>
    : <Button variant="primary" size="sm" className={styles.followBtn} onClick={onToggle} disabled={pending} aria-pressed="false">Follow</Button>;
}

export const FETCHING_TEXT = 'Fetching details from MusicBrainz and Wikipedia';

/**
 * Where the details stand, said once and calmly: a fetch in progress for
 * everyone; a failed fetch plainly, with Retry in Maintenance. A fetch that
 * never reported back (stalled) or an artist without an MBID says nothing:
 * the page shows what it has.
 */
export function DetailsNote({ state, maintenance, onRetry, retrying, compact = false }: {
  state: DetailsState;
  maintenance: boolean;
  onRetry: () => void;
  retrying: boolean;
  /** A's line above the name: no box */
  compact?: boolean;
}) {
  if (state === 'fetching') {
    return <div className={compact ? styles.fetchLine : styles.note} role="status">
      <span className={styles.spin} aria-hidden="true" />{FETCHING_TEXT}
    </div>;
  }
  if (state === 'failed') {
    return maintenance
      ? <div className={`${styles.note} ${styles.noteFailed}`} role="status">
        Couldn’t fetch details.
        <Button variant="quiet" size="sm" className={styles.noteAction} onClick={onRetry} loading={retrying}>Retry</Button>
      </div>
      : <p className={styles.quietNote}>Couldn’t fetch details.</p>;
  }
  return null;
}

/** "From Wikipedia · CC BY-SA 4.0" */
export function BioSource({ bio }: { bio: NonNullable<ArtistDetail['bio']> }) {
  return <span>From <a href={bio.url} target="_blank" rel="noopener noreferrer">Wikipedia</a> · {bio.license || 'CC BY-SA 4.0'}</span>;
}

/** B's biography: the first two paragraphs, "Show all" for the rest. */
export function Biography({ bio, headingId }: { bio: NonNullable<ArtistDetail['bio']>; headingId: string }) {
  const [all, setAll] = useState(false);
  const ps = paragraphs(bio.text);
  const shown = all ? ps : ps.slice(0, 2);
  return <>
    {shown.map((p, i) => <p key={i} className={i === 0 ? styles.bioLead : undefined}>{p}</p>)}
    <div className={styles.bioSource}>
      {ps.length > 2 && <Button variant="quiet" size="sm" className={styles.showAll} onClick={() => setAll(!all)} aria-expanded={all} aria-controls={headingId}>{all ? 'Show less' : 'Show all'}</Button>}
      <BioSource bio={bio} />
    </div>
  </>;
}

const LINK_LABELS: Array<[keyof ArtistDetail['links'], string]> = [
  ['musicbrainz', 'MusicBrainz'], ['wikidata', 'Wikidata'], ['wikipedia', 'Wikipedia'], ['discogs', 'Discogs'],
];

export function ProviderLinks({ links }: { links: ArtistDetail['links'] }) {
  const shown = LINK_LABELS.filter(([k]) => links[k]);
  if (!shown.length) return <span className={styles.when}>No provider links yet</span>;
  return <>{shown.map(([k, label]) => <a key={k} className={styles.chipLink} href={links[k]!} target="_blank" rel="noopener noreferrer">{label}</a>)}</>;
}

/** When the details were fetched, or why they are not. */
export function detailsWhen(artist: ArtistDetail, state: DetailsState): string {
  if (state === 'none') return 'No MusicBrainz id: details can’t be fetched';
  if (state === 'fetching') return 'Fetching details…';
  if (artist.enrichedAt) return `Details from ${shortDate(artist.enrichedAt)}`;
  return 'Details not fetched yet';
}
