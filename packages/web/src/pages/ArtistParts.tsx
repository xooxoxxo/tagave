/**
 * Pieces both artist page layouts share: the album card and grid, the
 * follow button, the details note (fetching, failed), the short biography,
 * About and the Maintenance tools.
 */
import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, CoverArt, CoverChip, IconButton, UndoIcon, type CoverChipTone } from '../components/ui';
import type { ArtistAlbum, ArtistAlbumOwnership, ArtistDetail } from '../hooks';
import { aboutFacts, paragraphs, shortDate, type DetailsState } from './artistPageView';
import { ListenControl, MissingListenLinks, MissingPrimary, PlayOnControl } from '../components/ListenControl';
import { splitPrimary } from '@tagave/shared';
import { LidarrChip, MissingAlbumMenu } from '../components/LidarrControls';
import styles from './ArtistPage.module.css';

const CHIP: Partial<Record<ArtistAlbumOwnership, [string, CoverChipTone]>> = {
  physical: ['Physical only', 'neutral'],
  both: ['Physical + digital', 'accent'],
};

type ArtistOrigin = { id: string; name: string };

export function AlbumCard({ album, artistOrigin, onReopen, reopening }: {
  album: ArtistAlbum;
  artistOrigin?: ArtistOrigin | undefined;
  /** a skipped release: bring it back to the missing list */
  onReopen?: ((gapId: string) => void) | undefined;
  reopening?: boolean;
}) {
  const away = album.ownership === 'missing' || album.ownership === 'ignored';
  const chip = CHIP[album.ownership];
  // Listen elsewhere: a missing album's links (the listen-links module)
  const listen = useContext(MissingListenLinks);
  const links = album.ownership === 'missing' && album.releaseGroupId ? listen?.[album.releaseGroupId] ?? [] : [];
  // "Play on <primary>", the others in the Listen control
  const split = splitPrimary(links, useContext(MissingPrimary));
  const cover = (
    <CoverArt src={album.coverUrl} title={album.title} dimmed={away ? (album.ownership as 'missing' | 'ignored') : undefined} interactive={!!album.localAlbumId}>
      {chip && <CoverChip tone={chip[1]}>{chip[0]}</CoverChip>}
      {album.ownership === 'missing' && <LidarrChip releaseGroupId={album.releaseGroupId} />}
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
      <Link to="/albums/$albumId" params={{ albumId: album.localAlbumId }} className={styles.cardLink}
        state={(previous) => ({
          ...previous,
          albumArtistOrigin: album.matchedBy === 'tags' && artistOrigin ? { id: artistOrigin.id, name: artistOrigin.name } : undefined,
        })}>{cover}{text}</Link>
    </li>;
  }
  // A missing album can be requested directly. Its menu manages an existing request.
  const more = album.ownership === 'missing' ? <MissingAlbumMenu releaseGroupId={album.releaseGroupId} title={album.title} /> : null;
  return <li className={`${styles.card} ${away ? styles.cardAway : ''}`}>{cover}
    {more ? <div className={styles.cardHead}><div className={styles.cardText}>{text}</div>{more}</div> : text}
    {album.ownership === 'missing' && <MissingAlbumMenu releaseGroupId={album.releaseGroupId} title={album.title} placement="card" />}
    {split.primary ? <div className={styles.cardListenRow}>
      <PlayOnControl link={split.primary} />
      {split.others.length > 0 && <ListenControl links={split.others} beside />}
    </div> : split.others.length > 0 && <ListenControl links={split.others} className={styles.cardListen} />}
  </li>;
}

export function AlbumGrid({ albums, artistOrigin, onReopen, reopening }: { albums: ArtistAlbum[]; artistOrigin?: ArtistOrigin; onReopen?: ((gapId: string) => void) | undefined; reopening?: boolean }) {
  return <ul className={styles.grid}>
    {albums.map((a) => <AlbumCard key={a.key} album={a} artistOrigin={artistOrigin} onReopen={onReopen} reopening={!!reopening} />)}
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

/**
 * The biography in the header: about three lines, More for the rest in
 * place, Less to fold it again (owner, 2026-11-04: "reduce the length of the
 * artist info collapsed version"). More shows only when there is more.
 */
export function ShortBio({ bio, className }: { bio: NonNullable<ArtistDetail['bio']>; className?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const ps = paragraphs(bio.text);
  const lead = useRef<HTMLParagraphElement>(null);
  // until measured (and without a DOM): More whenever there is a second paragraph
  const [cut, setCut] = useState(ps.length > 1);
  useLayoutEffect(() => {
    const el = lead.current;
    if (!el || open) return;
    const measure = () => setCut(ps.length > 1 || el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, ps.length]);
  return <div className={`${styles.shortBio} ${className ?? ''}`} data-open={open ? '' : undefined}>
    {open
      ? ps.map((p, i) => <p key={i}>{p}</p>)
      : <p ref={lead} className={styles.clamped}>{ps.join(' ')}</p>}
    {(cut || open) && <button type="button" className={styles.textLink} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Less' : 'More'}</button>}
  </div>;
}

const LINK_LABELS: Array<[keyof ArtistDetail['links'], string]> = [
  ['musicbrainz', 'MusicBrainz'], ['wikidata', 'Wikidata'], ['wikipedia', 'Wikipedia'], ['discogs', 'Discogs'],
];

/**
 * About, under the albums: the trivia the header no longer carries — years,
 * other names, MusicBrainz's description — then where the biography comes
 * from and the artist's pages elsewhere. Labels and values.
 */
export function ArtistAbout({ artist, details, owned }: { artist: ArtistDetail; details: DetailsState; owned?: string | undefined }) {
  const facts = aboutFacts(artist);
  // the biography's source leads the links, with its licence; the others follow
  const links = LINK_LABELS.filter(([k]) => artist.links?.[k] && !(k === 'wikipedia' && artist.bio));
  const any = !!artist.bio || links.length > 0;
  return <dl className={styles.about}>
    {owned && <div className={styles.row}><dt>In your library</dt><dd>{owned}</dd></div>}
    {facts.map(([k, v]) => <div key={k} className={styles.row}><dt>{k}</dt><dd dir="auto">{v}</dd></div>)}
    {!artist.bio && details === 'done' && <div className={styles.row}><dt>Biography</dt><dd className={styles.none}>None on Wikipedia</dd></div>}
    {any && <div className={styles.row}><dt>Links</dt><dd className={styles.aboutLinks}>
      {artist.bio && <span><a href={artist.bio.url} target="_blank" rel="noopener noreferrer">Wikipedia</a> · {artist.bio.license || 'CC BY-SA 4.0'}</span>}
      {links.map(([k, label]) => <a key={k} href={artist.links[k]!} target="_blank" rel="noopener noreferrer">{label}</a>)}
    </dd></div>}
  </dl>;
}

/** When the details were fetched, or why they are not. */
export function detailsWhen(artist: ArtistDetail, state: DetailsState): string {
  if (state === 'none') return 'No MusicBrainz id: details can’t be fetched';
  if (state === 'fetching') return 'Fetching details…';
  if (artist.enrichedAt) return `Details from ${shortDate(artist.enrichedAt)}`;
  return 'Details not fetched yet';
}
