/**
 * One playlist: its mosaic cover, its name (rename in place), how many
 * tracks and how long, Shuffle | Play | ⋮ (Export, Delete), and its tracks.
 * A row plays the list from there; its handle reorders (drag, or Arrow up /
 * down on it); its ⋮ has Play next, Add to queue, Add to playlist, the
 * album and the artist, and Remove from this playlist. A track that left
 * the library stays, dimmed, as "Missing".
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import type { PlaylistItemView, PlaylistView } from '@tagave/shared';
import {
  CoverArt, EmbossIconButton, EmptyState, ExportIcon, GripIcon, KebabIcon, PageShell, PauseIcon, PlayIcon, ShuffleIcon, TrashIcon, CloseIcon, confirmDialog, showToast,
} from '../components/ui';
import { InlineRename } from '../components/InlineRename';
import { PlaylistCover } from '../components/playlists/PlaylistCover';
import { TrackActions } from '../components/player/TrackActions';
import { useDragReorder } from '../components/player/useDragReorder';
import { download, playlistExportUrl, useDeletePlaylist, usePatchPlaylist, usePlaylist, useRemovePlaylistItem } from '../hooks/usePlaylists';
import { useCapabilities } from '../hooks/usePlayer';
import { currentTrack, playTracks, toggle, usePlayerStore } from '../player/engine';
import { clock } from '../player/logic';
import { tracksLabel } from './PlaylistsPage';
import styles from './PlaylistPage.module.css';

export function playlistLength(ms: number): string {
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  return h ? `${h} h ${min % 60} min` : `${min} min`;
}

export interface PlaylistPageViewProps {
  playlist: PlaylistView;
  /** a player is set up: Play, Shuffle and the rows play */
  canPlay: boolean;
  /** the list is the one playing, and how */
  playing: 'playing' | 'paused' | null;
  currentTrackId: string | null;
  onPlay: (startItem?: PlaylistItemView) => void;
  onShuffle: () => void;
  onToggle: () => void;
  onRename: (name: string) => Promise<unknown>;
  onMove: (from: number, to: number) => void;
  onRemove: (item: PlaylistItemView) => void;
  onDelete: () => void;
  onExport: () => void;
}

function ListMenu({ onExport, onDelete }: { onExport: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  return (
    <span ref={ref} className={styles.anchor} onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus(); } }}>
      <EmbossIconButton label="More for this playlist" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><KebabIcon /></EmbossIconButton>
      {open && (
        <span role="menu" className={styles.listMenu}>
          <button type="button" role="menuitem" autoFocus className={styles.listItem} onClick={() => { setOpen(false); onExport(); }}><ExportIcon /><span>Export</span></button>
          <button type="button" role="menuitem" className={`${styles.listItem} ${styles.danger}`} onClick={() => { setOpen(false); onDelete(); }}><TrashIcon /><span>Delete</span></button>
        </span>
      )}
    </span>
  );
}

/** The page alone, driven by props (stories, tests). */
export function PlaylistPageView(p: PlaylistPageViewProps) {
  const list = useRef<HTMLOListElement>(null);
  const { drag, handle } = useDragReorder({ list, canMove: () => true, onMove: p.onMove });
  const items = p.playlist.items;
  const playable = items.some((i) => i.localTrackId);
  return (
    <PageShell
      back
      barTitle={p.playlist.name}
      hero={
        <div className={styles.hero}>
          <PlaylistCover covers={p.playlist.covers} name={p.playlist.name} className={styles.cover} />
          <div className={styles.heroText}>
            <span className={styles.kicker}>Playlist</span>
            <div className={styles.name}><InlineRename value={p.playlist.name} label="Rename playlist" onSave={p.onRename} /></div>
            <span className={styles.meta}>{tracksLabel(p.playlist.tracks)}{p.playlist.durationMs > 0 ? ` · ${playlistLength(p.playlist.durationMs)}` : ''}</span>
            <div className={styles.actions} role="group" aria-label="Playlist actions">
              {p.canPlay && <EmbossIconButton label="Shuffle" disabled={!playable} onClick={p.onShuffle}><ShuffleIcon /></EmbossIconButton>}
              {p.canPlay && (
                <EmbossIconButton label={p.playing === 'playing' ? 'Pause' : p.playing === 'paused' ? 'Resume' : 'Play'} className={styles.play} disabled={!playable} onClick={p.playing ? p.onToggle : () => p.onPlay()}>
                  {p.playing === 'playing' ? <PauseIcon /> : <PlayIcon />}
                </EmbossIconButton>
              )}
              <ListMenu onExport={p.onExport} onDelete={p.onDelete} />
            </div>
          </div>
        </div>
      }
    >
      {items.length === 0 ? <EmptyState title="No tracks yet" /> : (
        <ol ref={list} className={styles.list}>
          {items.map((it, i) => {
            const now = !!it.localTrackId && it.localTrackId === p.currentTrackId;
            const lifted = drag?.from === i;
            const missing = !it.localTrackId;
            return (
              <li
                key={it.id}
                className={styles.row}
                data-drag-row=""
                data-lifted={lifted || undefined}
                data-missing={missing || undefined}
                data-now={now || undefined}
                style={lifted ? ({ '--dy': `${drag!.dy}px` } as CSSProperties) : undefined}
              >
                {drag && drag.to === i && drag.from !== i && <span className={styles.drop} data-below={drag.to > drag.from || undefined} aria-hidden="true" />}
                <button type="button" className={styles.grip} aria-label={`Move ${it.title}`} title="Drag, or use the arrow keys" {...handle(i)}><GripIcon /></button>
                <button type="button" className={styles.main} disabled={missing || !p.canPlay} onClick={() => p.onPlay(it)} aria-current={now || undefined}>
                  <CoverArt src={it.coverUrl} title={it.album ?? it.title} compact className={styles.thumb} />
                  <span className={styles.names}>
                    <span className={styles.title} dir="auto">{it.title}</span>
                    <span className={styles.artist} dir="auto">{missing ? 'Missing' : it.artist}</span>
                  </span>
                  <span className={styles.album} dir="auto">{it.album}</span>
                  <span className={styles.time}>{it.durationMs ? clock(it.durationMs / 1000) : ''}</span>
                </button>
                <span className={styles.rowMenu}>
                  {missing ? (
                    <EmbossIconButton label={`Remove ${it.title}`} onClick={() => p.onRemove(it)}><CloseIcon /></EmbossIconButton>
                  ) : (
                    <TrackActions
                      label={`More for ${it.title}`}
                      summary={{ title: it.title, subtitle: [it.artist, it.album].filter(Boolean).join(' · '), coverUrl: it.coverUrl }}
                      source={{ trackIds: [it.localTrackId!] }}
                      albumId={it.albumId}
                      extra={[{ key: 'remove', label: 'Remove from this playlist', icon: <TrashIcon />, tone: 'danger', onSelect: () => p.onRemove(it) }]}
                    />
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </PageShell>
  );
}

export function PlaylistPage() {
  const { playlistId } = useParams({ strict: false }) as { playlistId: string };
  const navigate = useNavigate();
  const q = usePlaylist(playlistId);
  const patch = usePatchPlaylist();
  const remove = useRemovePlaylistItem();
  const del = useDeletePlaylist();
  const canPlay = useCapabilities().data?.player?.installed === true;
  const status = usePlayerStore((s) => s.status);
  const context = usePlayerStore((s) => s.queue?.context);
  const currentId = usePlayerStore((s) => currentTrack(s)?.localTrackId ?? null);
  // a reorder shows at once; the server's answer replaces it
  const [order, setOrder] = useState<PlaylistItemView[] | null>(null);
  useEffect(() => { setOrder(null); }, [q.data]);

  if (q.isError) return <PageShell title="Playlist" back><EmptyState title="Not found" /></PageShell>;
  if (!q.data) return null;
  const view: PlaylistView = order ? { ...q.data, items: order } : q.data;
  const mine = context?.kind === 'playlist' && context.id === view.id;
  const playing = mine ? (status === 'playing' || status === 'buffering' || status === 'loading' ? 'playing' : 'paused') : null;
  const ids = view.items.map((i) => i.localTrackId).filter((x): x is string => !!x);
  const ctx = { kind: 'playlist' as const, id: view.id, name: view.name };
  return (
    <PlaylistPageView
      playlist={view}
      canPlay={canPlay}
      playing={playing}
      currentTrackId={mine ? currentId : null}
      onPlay={(it) => void playTracks(ids, ctx, { startTrackId: it?.localTrackId ?? null })}
      onShuffle={() => void playTracks(ids, ctx, { shuffle: true })}
      onToggle={toggle}
      onRename={(name) => patch.mutateAsync({ id: view.id, name })}
      onMove={(from, to) => {
        const next = [...view.items];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved!);
        setOrder(next);
        patch.mutate({ id: view.id, order: next.map((i) => i.id) }, { onError: () => { setOrder(null); showToast({ message: 'Not moved. Try again.', tone: 'danger' }); } });
      }}
      onRemove={(it) => remove.mutate({ id: view.id, itemId: it.id }, { onError: () => showToast({ message: 'Not removed. Try again.', tone: 'danger' }) })}
      onExport={() => download(playlistExportUrl(view.id))}
      onDelete={() => {
        void confirmDialog({ title: `Delete ${view.name}?`, confirmLabel: 'Delete', tone: 'danger' }).then((ok) => {
          if (!ok) return;
          del.mutate(view.id, { onSuccess: () => void navigate({ to: '/playlists' }) });
        });
      }}
    />
  );
}
