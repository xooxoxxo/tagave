/**
 * Playlists (the playlists module; direction B, Qobuz): the person's own
 * lists as a grid of mosaic covers, newest change first. The header holds
 * New playlist (a tile with a name field), Import (tagave's file, M3U8 or
 * XSPF) and Export all (one *.tagave-playlist.json). Each list is private.
 */
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { EmbossIconButton, EmptyState, ExportIcon, ImportIcon, PageShell, PlusIcon, showToast } from '../components/ui';
import { PlaylistCover } from '../components/playlists/PlaylistCover';
import { download, playlistExportUrl, useCreatePlaylist, useImportPlaylists, usePlaylists, usePlaylistsOn } from '../hooks/usePlaylists';
import { useModuleOn } from '../hooks/useFacets';
import type { PlaylistSummary } from '@tagave/shared';
import styles from './PlaylistsPage.module.css';

const ACCEPT = '.json,.m3u,.m3u8,.xspf,application/json,audio/x-mpegurl,application/xspf+xml';

export function tracksLabel(n: number): string {
  return n === 1 ? '1 track' : `${n} tracks`;
}

export interface PlaylistsGridProps {
  playlists: readonly PlaylistSummary[];
  /** the New playlist tile shows its name field */
  naming?: boolean;
  onNew?: (() => void) | undefined;
  onCreate?: ((name: string) => Promise<void>) | undefined;
  onCancelNew?: (() => void) | undefined;
}

/** The grid alone (stories, tests). */
export function PlaylistsGrid({ playlists, naming = false, onCreate, onCancelNew }: PlaylistsGridProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !onCreate) return;
    setBusy(true);
    try { await onCreate(name.trim()); setName(''); } finally { setBusy(false); }
  };
  return (
    <ul className={styles.grid}>
      {naming && (
        <li>
          <form className={styles.newTile} onSubmit={(e) => void submit(e)}>
            <span className={styles.newCover} aria-hidden="true"><PlusIcon /></span>
            <label className={styles.srOnly} htmlFor="new-playlist-name">Playlist name</label>
            <input
              id="new-playlist-name"
              className={styles.newField}
              value={name}
              maxLength={200}
              placeholder="Name"
              autoFocus
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onCancelNew?.(); }}
              onBlur={() => { if (!name.trim()) onCancelNew?.(); }}
            />
          </form>
        </li>
      )}
      {playlists.map((p) => (
        <li key={p.id}>
          <Link to="/playlists/$playlistId" params={{ playlistId: p.id }} className={styles.tile}>
            <PlaylistCover covers={p.covers} name={p.name} className={styles.tileCover} />
            <span className={styles.tileName} dir="auto">{p.name}</span>
            <span className={styles.tileMeta}>{tracksLabel(p.tracks)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function PlaylistsPage() {
  const on = usePlaylistsOn();
  const known = useModuleOn('playlists');
  const lists = usePlaylists();
  const create = useCreatePlaylist();
  const importer = useImportPlaylists();
  const navigate = useNavigate();
  // ?new=1 (New playlist from the phone's menu): the name field is open
  const search = useSearch({ strict: false }) as { new?: unknown };
  const [naming, setNaming] = useState(!!search.new);
  const file = useRef<HTMLInputElement>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    try {
      const result = await importer.mutateAsync({ content: await f.text(), fileName: f.name });
      const found = result.playlists.reduce((n, p) => n + p.matched, 0);
      const all = result.playlists.reduce((n, p) => n + p.tracks, 0);
      showToast({ message: result.playlists.length === 1 ? `${result.playlists[0]!.name} · ${found} of ${tracksLabel(all)}` : `${result.playlists.length} playlists · ${found} of ${tracksLabel(all)}` });
    } catch (err) {
      showToast({ message: (err as { detail?: string }).detail ?? 'Not imported.', tone: 'danger' });
    }
  };

  if (known === false) return <PageShell title="Playlists"><EmptyState title="Playlists are turned off" /></PageShell>;
  const actions = on && (
    <div className={styles.tools}>
      <input ref={file} type="file" accept={ACCEPT} hidden onChange={(e) => void onFile(e)} />
      <EmbossIconButton label="Import a playlist" disabled={importer.isPending} onClick={() => file.current?.click()}><ImportIcon /></EmbossIconButton>
      <EmbossIconButton label="Export all" disabled={!lists.data?.length} onClick={() => download(playlistExportUrl())}><ExportIcon /></EmbossIconButton>
      <EmbossIconButton label="New playlist" onClick={() => setNaming(true)}><PlusIcon /></EmbossIconButton>
    </div>
  );
  return (
    <PageShell title="Playlists" actions={actions}>
      {lists.isLoading ? null : (lists.data?.length ?? 0) === 0 && !naming ? (
        <EmptyState title="No playlists yet" action={<button type="button" className={styles.emptyNew} onClick={() => setNaming(true)}>New playlist</button>} />
      ) : (
        <PlaylistsGrid
          playlists={lists.data ?? []}
          naming={naming}
          onCancelNew={() => setNaming(false)}
          onCreate={async (name) => {
            const p = await create.mutateAsync({ name });
            setNaming(false);
            void navigate({ to: '/playlists/$playlistId', params: { playlistId: p.id } });
          }}
        />
      )}
    </PageShell>
  );
}
