/**
 * The artist page's Similar artists (the similar-artists module), below the
 * albums and above About. Labels and values only.
 *
 *   In your library      the artist card (picture, name, albums) linking
 *                        to their page, and Play: a shuffled mix of their
 *                        tracks, when the player is set up
 *   Not in your library  dimmed like missing albums: the name (their page
 *                        when tagave has one), MusicBrainz's short comment,
 *                        Listen elsewhere, and Follow so their missing albums
 *                        appear (Get through Lidarr goes from there)
 *
 * Wide: the cards in a grid, the others in columns of rows. A phone: the
 * cards in one row that scrolls sideways, the others a compact list.
 * SimilarArtistsView is the section alone, driven by props (stories,
 * tests); the artist page connects it.
 */
import { Link } from '@tanstack/react-router';
import { artistLabel, splitPrimary, type ArtistSimilarView, type SimilarElsewhereView, type SimilarInLibraryView } from '@tagave/shared';
import { ArtistArtwork } from '../components/ArtistArtwork';
import { ListenControl, PlayOnControl } from '../components/ListenControl';
import { Button, EmbossIconButton, PlayIcon } from '../components/ui';
import { Bar } from './ArtistParts';
import styles from './SimilarArtists.module.css';

export interface SimilarArtistsViewProps {
  view: ArtistSimilarView;
  /** Follow is library care: absent for a listener */
  onFollow?: ((a: SimilarElsewhereView) => void) | undefined;
  /** the one being followed now (its name) */
  following?: string | null;
  /** Play a mix: absent without the player */
  onPlay?: ((a: SimilarInLibraryView) => void) | undefined;
  /** the one whose mix is loading (its artist id) */
  loading?: string | null;
}

const albumsLine = (n: number) => `${n} ${n === 1 ? 'album' : 'albums'}`;

/** How many the section lists: its count in the heading and the section links. */
export function similarCount(view: ArtistSimilarView | null | undefined): number {
  return view ? view.inLibrary.length + view.elsewhere.length : 0;
}

/** Whether the section shows: on, and something in it or on its way. */
export function showsSimilar(view: ArtistSimilarView | null | undefined): boolean {
  return !!view?.available && (view.pending || similarCount(view) > 0);
}

function LibraryCard({ a, onPlay, loading }: { a: SimilarInLibraryView; onPlay: SimilarArtistsViewProps['onPlay']; loading: boolean }) {
  const name = artistLabel(a.name);
  return <li className={styles.card}>
    {/* the picture repeats the name's link for the pointer; the name is the one link for keyboard and screen readers */}
    <Link to="/artists/$artistId" params={{ artistId: a.artistId }} className={styles.cardLink} tabIndex={-1} aria-hidden="true">
      <ArtistArtwork name={a.name} coverAlbumIds={a.coverAlbumIds} />
    </Link>
    <div className={styles.cardHead}>
      <Link to="/artists/$artistId" params={{ artistId: a.artistId }} className={styles.cardText}>
        <span className={styles.cardName} dir="auto">{name}</span>
        <span className={styles.cardMeta}>{albumsLine(a.albums)}</span>
      </Link>
      {onPlay && <EmbossIconButton label={`Play ${name}`} className={styles.play} aria-busy={loading || undefined} disabled={loading} onClick={() => onPlay(a)}>
        {loading ? <span className={styles.spinner} aria-hidden="true" /> : <PlayIcon />}
      </EmbossIconButton>}
    </div>
  </li>;
}

function ElsewhereRow({ a, primary, onFollow, following }: { a: SimilarElsewhereView; primary: ArtistSimilarView['primary']; onFollow: SimilarArtistsViewProps['onFollow']; following: boolean }) {
  const split = splitPrimary(a.listen, primary);
  const name = <span className={styles.rowName} dir="auto">{a.name}</span>;
  const canFollow = !!onFollow && !a.followed && (!!a.artistId || !!a.mbid);
  return <li className={styles.row}>
    <div className={styles.rowText}>
      {a.artistId ? <Link to="/artists/$artistId" params={{ artistId: a.artistId }} className={styles.rowLink}>{name}</Link> : name}
      {a.comment && <span className={styles.rowComment} dir="auto">{a.comment}</span>}
    </div>
    <div className={styles.rowActs}>
      {split.primary && <PlayOnControl link={split.primary} />}
      {split.others.length > 0 && <ListenControl links={split.others} beside={!!split.primary} />}
      {a.followed
        ? <span className={styles.followed}>Following</span>
        : canFollow && <Button variant="secondary" size="sm" disabled={following} onClick={() => onFollow!(a)}>Follow</Button>}
    </div>
  </li>;
}

export function SimilarArtistsView({ view, onFollow, following = null, onPlay, loading = null }: SimilarArtistsViewProps) {
  if (view.pending && similarCount(view) === 0) {
    return <div className={styles.loading} role="status" aria-busy="true" aria-label="Loading similar artists">
      <ul className={styles.cards} aria-hidden="true">
        {[0, 1, 2, 3].map((i) => <li key={i} className={styles.card}><div className={styles.skel} /><Bar width="70%" className={styles.skelLine} /></li>)}
      </ul>
    </div>;
  }
  return <div className={styles.similar}>
    {view.inLibrary.length > 0 && <div className={styles.group}>
      <p className={styles.label}>In your library</p>
      <ul className={styles.cards}>
        {view.inLibrary.map((a) => <LibraryCard key={a.artistId} a={a} onPlay={onPlay} loading={loading === a.artistId} />)}
      </ul>
    </div>}
    {view.elsewhere.length > 0 && <div className={styles.group}>
      <p className={styles.label}>Not in your library</p>
      <ul className={styles.rows}>
        {view.elsewhere.map((a) => <ElsewhereRow key={a.mbid ?? a.name} a={a} primary={view.primary} onFollow={onFollow} following={following === a.name} />)}
      </ul>
    </div>}
  </div>;
}
