/**
 * The person's playlists to add to, New playlist first (a name field once
 * picked): the rows of the ⋮'s submenu on a desktop and of the drawer's
 * second step on a phone. Picking one adds and says so in a toast.
 */
import { useState } from 'react';
import { PlusIcon, showToast } from '../ui';
import type { QueueSource } from '../../player/engine';
import { useAddToPlaylist, useCreatePlaylist, usePlaylists } from '../../hooks/usePlaylists';
import { PlaylistCover } from '../playlists/PlaylistCover';
import menu from '../ui/Menu.module.css';
import drawer from '../../pages/AlbumMenu.module.css';
import styles from './TrackActions.module.css';

export function PlaylistChoices({ source, onDone, variant }: { source: QueueSource; onDone: () => void; variant: 'menu' | 'drawer' }) {
  const lists = usePlaylists();
  const add = useAddToPlaylist();
  const create = useCreatePlaylist();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const body = 'albumId' in source ? { albumId: source.albumId } : { trackIds: source.trackIds };
  const addTo = async (id: string, listName: string) => {
    onDone();
    try {
      await add.mutateAsync({ id, ...body });
      showToast({ message: `Added to ${listName}` });
    } catch {
      showToast({ message: 'Not added. Try again.', tone: 'danger' });
    }
  };
  const createWith = async () => {
    const n = name.trim();
    if (!n) return;
    onDone();
    try {
      const p = await create.mutateAsync({ name: n });
      await add.mutateAsync({ id: p.id, ...body });
      showToast({ message: `Added to ${n}` });
    } catch {
      showToast({ message: 'Not added. Try again.', tone: 'danger' });
    }
  };
  const field = (
    <form className={variant === 'menu' ? styles.newForm : styles.newFormDrawer} onSubmit={(e) => { e.preventDefault(); void createWith(); }}>
      <label className={styles.srOnly} htmlFor={`new-playlist-${variant}`}>Playlist name</label>
      <input
        id={`new-playlist-${variant}`}
        className={styles.newField}
        value={name}
        maxLength={200}
        placeholder="Name"
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setNaming(false); }}
      />
      <button type="submit" className={styles.newSave} disabled={!name.trim()}>Create</button>
    </form>
  );
  if (variant === 'menu') {
    return (
      <>
        {naming ? field : (
          <button type="button" role="menuitem" tabIndex={-1} className={`${menu.item} ${styles.item}`} onClick={() => setNaming(true)}>
            <span className={styles.icon}><PlusIcon /></span><span className={styles.text}>New playlist</span>
          </button>
        )}
        {(lists.data ?? []).map((p, n) => (
          <button key={p.id} type="button" role="menuitem" tabIndex={-1} className={`${menu.item} ${styles.item} ${n === 0 ? menu.separated : ''}`} onClick={() => void addTo(p.id, p.name)}>
            <PlaylistCover covers={p.covers} name={p.name} className={styles.listCover} />
            <span className={styles.text}>{p.name}</span>
          </button>
        ))}
      </>
    );
  }
  return (
    <ul className={drawer.rows}>
      <li>
        {naming ? field : (
          <button type="button" className={drawer.row} onClick={() => setNaming(true)}>
            <span className={styles.newCover}><PlusIcon /></span>
            <span className={drawer.rowText}><span className={drawer.rowLabel}>New playlist</span></span>
          </button>
        )}
      </li>
      {(lists.data ?? []).map((p) => (
        <li key={p.id}>
          <button type="button" className={drawer.row} onClick={() => void addTo(p.id, p.name)}>
            <PlaylistCover covers={p.covers} name={p.name} className={styles.drawerCover} />
            <span className={drawer.rowText}><span className={drawer.rowLabel}>{p.name}</span><span className={drawer.rowHint}>{p.tracks === 1 ? '1 track' : `${p.tracks} tracks`}</span></span>
          </button>
        </li>
      ))}
    </ul>
  );
}
