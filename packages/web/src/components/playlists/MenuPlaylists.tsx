/**
 * The person's playlists in the phone's menu sheet (direction A): a
 * "Playlists" heading that opens the Playlists page, New playlist beside it,
 * and each list with its mosaic. On a desktop the sidebar has the Playlists
 * link instead (the page is the grid).
 */
import { Link, useNavigate } from '@tanstack/react-router';
import { EmbossIconButton, PlusIcon } from '../ui';
import { usePlaylists, usePlaylistsOn } from '../../hooks/usePlaylists';
import { PlaylistCover } from './PlaylistCover';
import styles from './MenuPlaylists.module.css';

export function MenuPlaylists({ activeId }: { activeId?: string | null | undefined }) {
  const on = usePlaylistsOn();
  const lists = usePlaylists();
  const navigate = useNavigate();
  if (!on) return null;
  return (
    <section className={styles.section} aria-labelledby="menu-playlists">
      <div className={styles.head}>
        <Link id="menu-playlists" to="/playlists" className={styles.title}>Playlists</Link>
        <EmbossIconButton label="New playlist" place="header" className={styles.add} onClick={() => void navigate({ to: '/playlists', search: { new: 1 } as never })}><PlusIcon /></EmbossIconButton>
      </div>
      <ul className={styles.items}>
        {(lists.data ?? []).map((p) => (
          <li key={p.id}>
            <Link to="/playlists/$playlistId" params={{ playlistId: p.id }} className={styles.item} data-active={p.id === activeId || undefined}>
              <PlaylistCover covers={p.covers} name={p.name} className={styles.cover} />
              <span className={styles.name} dir="auto">{p.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
