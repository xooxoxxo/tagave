/**
 * Liked songs (0085): the person's hearted songs as a built-in list, newest
 * like first (Spotify's Liked Songs). Shuffle | Play and the rows play it;
 * it is not edited as a playlist: unliking a song (its heart, or Unlike in
 * its ⋮) takes it out. A song that left the library stays, dimmed, as
 * "Missing". LikedSongsView is the page alone, driven by props (stories).
 */
import { useContext } from 'react';
import type { LikedSongsView, LikedSongView } from '@tagave/shared';
import { BackIcon, CoverArt, EmbossIconButton, EmptyState, PageShell, PauseIcon, PlayIcon, ShuffleIcon } from '../components/ui';
import { TrackActions } from '../components/player/TrackActions';
import { LikeKey, LikeKeyView } from '../components/LikeKey';
import { PageBackActionContext } from '../components/ui/PageShell';
import { useLikedSongs, useToggleLike } from '../hooks/useLikes';
import { useCapabilities } from '../hooks/usePlayer';
import { currentTrack, playTracks, toggle, usePlayerStore } from '../player/engine';
import { clock } from '../player/logic';
import { useHiddenDeletions } from './deleteAction';
import { playlistLength } from './PlaylistPage';
import { tracksLabel } from './PlaylistsPage';
import styles from './PlaylistPage.module.css';
import { LIKED_SONGS, LikedCover } from '../components/playlists/LikedCover';
import own from './LikedSongsPage.module.css';

/** The queue's context: Now playing says "Playing from playlist · Liked songs". */
export const LIKED_CONTEXT = { kind: 'playlist' as const, id: 'liked', name: LIKED_SONGS };

export interface LikedSongsPageViewProps {
  view: LikedSongsView;
  canPlay: boolean;
  playing: 'playing' | 'paused' | null;
  currentTrackId: string | null;
  onPlay: (start?: LikedSongView) => void;
  onShuffle: () => void;
  onToggle: () => void;
  /** the heart of a row (stories pass one; the app's reads the person's likes) */
  heart?: ((item: LikedSongView) => React.ReactNode) | undefined;
  back?: { label: string; go: () => void } | null | undefined;
}

export function LikedSongsPageView(p: LikedSongsPageViewProps) {
  const items = p.view.items;
  const playable = items.some((i) => i.localTrackId);
  return (
    <PageShell
      back
      barTitle={LIKED_SONGS}
      hero={
        <>
          {p.back && <span className={styles.heroBack}><EmbossIconButton place="header" label={p.back.label} onClick={p.back.go}><BackIcon /></EmbossIconButton></span>}
          <div className={styles.hero}>
            <LikedCover className={styles.cover} />
            <div className={styles.heroText}>
              <span className={styles.kicker}>Playlist</span>
              <h1 className={styles.name}>{LIKED_SONGS}</h1>
              <span className={styles.meta}>{tracksLabel(p.view.count)}{p.view.durationMs > 0 ? ` · ${playlistLength(p.view.durationMs)}` : ''}</span>
              {p.canPlay && (
                <div className={styles.actions} role="group" aria-label="Playlist actions">
                  <EmbossIconButton label="Shuffle" disabled={!playable} onClick={p.onShuffle}><ShuffleIcon /></EmbossIconButton>
                  <EmbossIconButton label={p.playing === 'playing' ? 'Pause' : p.playing === 'paused' ? 'Resume' : 'Play'} className={styles.play} disabled={!playable} onClick={p.playing ? p.onToggle : () => p.onPlay()}>
                    {p.playing === 'playing' ? <PauseIcon /> : <PlayIcon />}
                  </EmbossIconButton>
                </div>
              )}
            </div>
          </div>
        </>
      }
    >
      {items.length === 0 ? <EmptyState title="No liked songs yet" /> : (
        <ol className={styles.list}>
          {items.map((it) => {
            const missing = !it.localTrackId;
            const now = !missing && it.localTrackId === p.currentTrackId;
            return (
              <li key={it.id} className={`${styles.row} ${own.row}`} data-missing={missing || undefined} data-now={now || undefined}>
                <button type="button" className={styles.main} disabled={missing || !p.canPlay} onClick={() => p.onPlay(it)} aria-current={now || undefined}>
                  <CoverArt src={it.coverUrl} title={it.album ?? it.title} compact className={styles.thumb} />
                  <span className={styles.names}>
                    <span className={styles.title} dir="auto">{it.title}</span>
                    <span className={styles.artist} dir="auto">{missing ? 'Missing' : it.artist}</span>
                  </span>
                  <span className={styles.album} dir="auto">{it.album}</span>
                  <span className={styles.time}>{it.durationMs ? clock(it.durationMs / 1000) : ''}</span>
                </button>
                <span className={own.heart}>{p.heart?.(it)}</span>
                <span className={`${styles.rowMenu} ${own.menu}`}>
                  {!missing && (
                    <TrackActions
                      label={`More for ${it.title}`}
                      summary={{ title: it.title, subtitle: [it.artist, it.album].filter(Boolean).join(' · '), coverUrl: it.coverUrl }}
                      source={{ trackIds: [it.localTrackId!] }}
                      albumId={it.albumId}
                      artist={it.artistLink}
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

export function LikedSongsPage() {
  const q = useLikedSongs();
  const back = useContext(PageBackActionContext);
  const canPlay = useCapabilities().data?.player?.installed === true;
  const status = usePlayerStore((s) => s.status);
  const context = usePlayerStore((s) => s.queue?.context);
  const currentId = usePlayerStore((s) => currentTrack(s)?.localTrackId ?? null);
  const hiddenDel = useHiddenDeletions();
  const unlike = useToggleLike();
  if (q.isError) return <PageShell title={LIKED_SONGS} back><EmptyState title="Not found" /></PageShell>;
  if (!q.data) return null;
  // a song deleted from here waits out its Undo out of the list
  const view: LikedSongsView = { ...q.data, items: q.data.items.filter((i) => !i.localTrackId || !hiddenDel.track(i.localTrackId)) };
  const mine = context?.kind === 'playlist' && context.id === LIKED_CONTEXT.id;
  const playing = mine ? (status === 'playing' || status === 'buffering' || status === 'loading' ? 'playing' : 'paused') : null;
  const ids = view.items.map((i) => i.localTrackId).filter((x): x is string => !!x);
  return (
    <LikedSongsPageView
      view={view}
      back={back}
      canPlay={canPlay}
      playing={playing}
      currentTrackId={mine ? currentId : null}
      onPlay={(it) => void playTracks(ids, LIKED_CONTEXT, { startTrackId: it?.localTrackId ?? null })}
      onShuffle={() => void playTracks(ids, LIKED_CONTEXT, { shuffle: true })}
      onToggle={toggle}
      // a Missing song has no track to like: its heart unlikes the like itself
      heart={(it) => (it.localTrackId
        ? <LikeKey kind="song" id={it.localTrackId} size="sm" />
        : <LikeKeyView liked size="sm" onToggle={() => unlike.mutate({ kind: 'song', id: it.id, like: false })} />)}
    />
  );
}
