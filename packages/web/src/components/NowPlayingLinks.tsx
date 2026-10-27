/**
 * The artist and album of what is playing, as links to their pages (the
 * player bar and the queue). A link changes the page only: the player is
 * mounted in Layout, so the music goes on.
 */
import { Fragment, type FocusEvent, type MouseEvent } from 'react';
import { Link } from '@tanstack/react-router';
import styles from './NowPlayingLinks.module.css';

export interface CreditedArtist { id: string; name: string }

const norm = (s: string) => s.trim().toLocaleLowerCase();

/**
 * The artists a track's artist text stands for, with their ids: the album's
 * credited artists when the track is credited to the album artist, the one
 * credited artist it names on a compilation, or null (plain text) when the
 * album has no identified artists or the name is not one of them.
 */
export function linkedArtists(trackArtist: string, albumArtist: string, artists: readonly CreditedArtist[] | null | undefined): CreditedArtist[] | null {
  if (!artists || artists.length === 0) return null;
  const t = norm(trackArtist);
  if (!t || t === norm(albumArtist) || t === norm(artists.map((a) => a.name).join(', '))) return [...artists];
  const one = artists.find((a) => norm(a.name) === t);
  return one ? [one] : null;
}

/** Each artist a link to their page, comma separated. */
export function ArtistLinks({ artists, onNavigate }: { artists: readonly CreditedArtist[]; onNavigate?: (() => void) | undefined }) {
  return (
    <>
      {artists.map((a, i) => (
        <Fragment key={`${a.id}-${i}`}>
          {i > 0 && ', '}
          <Link className={styles.link} to="/artists/$artistId" params={{ artistId: a.id }} onClick={onNavigate} dir="auto">{a.name}</Link>
        </Fragment>
      ))}
    </>
  );
}

/** The album's name, a link to its page. */
export function AlbumLink({ albumId, children, onNavigate }: { albumId: string; children: string; onNavigate?: (() => void) | undefined }) {
  return <Link className={styles.link} to="/albums/$albumId" params={{ albumId }} onClick={onNavigate} dir="auto">{children}</Link>;
}

/**
 * For the clipped line that holds the links: a focused link past the
 * ellipsis scrolls the line to show it; once focus leaves, or a link is
 * followed, the line starts at its beginning again.
 */
export const lineReset = {
  onBlur(e: FocusEvent<HTMLElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) e.currentTarget.scrollLeft = 0;
  },
  onClick(e: MouseEvent<HTMLElement>) {
    e.currentTarget.scrollLeft = 0;
  },
};
