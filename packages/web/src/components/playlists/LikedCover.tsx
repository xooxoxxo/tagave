/**
 * Liked songs' name and cover (0085): the heart on the accent, as Spotify
 * draws its Liked Songs. Shared by the Playlists grid and the list's page.
 */
import { HeartIcon } from '../ui';
import styles from './LikedCover.module.css';

export const LIKED_SONGS = 'Liked songs';

export function LikedCover({ className }: { className?: string | undefined }) {
  return <span className={[styles.cover, className].filter(Boolean).join(' ')} aria-hidden="true"><HeartIcon filled /></span>;
}
