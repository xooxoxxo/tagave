/**
 * A playlist's cover: a 2×2 mosaic of its first four albums' covers (Apple
 * Music, Spotify), one cover when it has fewer, the placeholder when none.
 */
import { CoverArt } from '../ui';
import styles from './PlaylistCover.module.css';

export function PlaylistCover({ covers, name, className }: { covers: readonly string[]; name: string; className?: string | undefined }) {
  if (covers.length >= 4) {
    return (
      <span className={[styles.mosaic, className].filter(Boolean).join(' ')} aria-hidden="true">
        {covers.slice(0, 4).map((c, i) => <img key={`${c}-${i}`} src={c} alt="" loading="lazy" decoding="async" />)}
      </span>
    );
  }
  return <CoverArt src={covers[0] ?? null} title={name} className={[styles.single, className].filter(Boolean).join(' ')} />;
}
