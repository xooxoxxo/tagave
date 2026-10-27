/**
 * The player bar: what is playing, previous / play-pause / next, a seek bar
 * and (on a desktop) the volume, along the foot of the content column. It is
 * mounted once in Layout, so moving between pages never stops the music; it
 * takes its own row under the page (the page scrolls above it, nothing is
 * covered). The queue key opens Now Playing (player/NowPlaying.tsx) over
 * the page; on a phone the mini bar stands in for the bar.
 * PlayerBarView is the bar alone, driven by props (stories, tests);
 * PlayerBar connects it to the engine (player/engine.ts).
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import type { PlayHistoryEntry } from '@tagave/shared';
import { CoverArt, IconButton, Button, PlayIcon, PauseIcon, PreviousIcon, NextIcon, CloseIcon, VolumeIcon, QueueIcon, showToast } from './ui';
import { clock, nextPlayable, spaceTogglesPlayback } from '../player/logic';
import { useCapabilities } from '../hooks/usePlayer';
import {
  checkHandover, clearQueue, currentTrack, enqueue, moveInQueue, next, persistOnLeave, playAt, previous, removeFromQueue, restoreQueue, retry, seek, setVolume, stop, toggle,
  usePlayerStore, type PlayerStatus,
} from '../player/engine';
import { useMediaQuery, PHONE_QUERY } from '../hooks/useMediaQuery';
import { playHistoryKey, useCreatePlaylist, usePlayHistory, usePlaylistsOn } from '../hooks/usePlaylists';
import { MiniPlayer, NowPlayingScreen, NowPlayingView } from './player/NowPlaying';
import { TrackActions } from './player/TrackActions';
import { AlbumLink, ArtistLinks, linkedArtists, lineReset, type CreditedArtist } from './NowPlayingLinks';
import styles from './PlayerBar.module.css';

export interface PlayerBarViewProps {
  title: string;
  artist: string;
  album: string;
  /** the artists `artist` stands for, with ids: each becomes a link to their page */
  artists?: readonly CreditedArtist[] | null | undefined;
  /** the album's id: its name becomes a link to its page */
  albumId?: string | null | undefined;
  coverUrl: string | null;
  status: PlayerStatus;
  /** the plain sentence of the error state */
  message?: string | null;
  /** seconds */
  position: number;
  duration: number | null;
  /** 0 to 1 */
  volume: number;
  canPrevious: boolean;
  canNext: boolean;
  onToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (sec: number) => void;
  onVolume: (volume: number) => void;
  onRetry: () => void;
  onClose: () => void;
  /** the queue panel is open (the queue key shows pressed) */
  queueOpen?: boolean;
  /** opens and closes the queue; without it there is no queue key */
  onQueue?: () => void;
}

/** The bar alone. */
export function PlayerBarView({ title, artist, album, artists, albumId, coverUrl, status, message, position, duration, volume, canPrevious, canNext, onToggle, onPrevious, onNext, onSeek, onVolume, onRetry, onClose, queueOpen = false, onQueue }: PlayerBarViewProps) {
  // while the thumb is dragged, the bar shows where it is, not the audio
  const [scrub, setScrub] = useState<number | null>(null);
  const busy = status === 'loading' || status === 'buffering';
  const playing = status === 'playing' || busy;
  const total = duration && Number.isFinite(duration) && duration > 0 ? duration : null;
  const shown = Math.min(scrub ?? position, total ?? Number.POSITIVE_INFINITY);
  const fill = total ? Math.min(100, Math.max(0, (shown / total) * 100)) : 0;
  const commit = () => {
    if (scrub != null) onSeek(scrub);
    setScrub(null);
  };
  const subtitle = artist && album ? `${artist} · ${album}` : artist || album;

  return (
    <section className={styles.bar} aria-label="Player" data-status={status}>
      <div className={styles.now}>
        <CoverArt src={coverUrl} title={album || title} compact className={styles.cover} />
        <div className={styles.names}>
          <span className={styles.title} title={title} dir="auto">{title}</span>
          {subtitle && (
            <span className={styles.artist} title={subtitle} dir="auto" {...lineReset}>
              {artists && artists.length > 0 ? <ArtistLinks artists={artists} /> : artist}
              {artist && album && ' · '}
              {album && (albumId ? <AlbumLink albumId={albumId}>{album}</AlbumLink> : album)}
            </span>
          )}
        </div>
      </div>

      <div className={styles.keys}>
        <IconButton label="Previous track" variant="quiet" size="sm" className={styles.key} onClick={onPrevious} disabled={!canPrevious}>
          <PreviousIcon />
        </IconButton>
        <IconButton
          label={playing ? 'Pause' : 'Play'}
          variant="secondary"
          className={styles.playKey}
          onClick={onToggle}
        >
          {busy ? <span className={styles.spinner} aria-hidden="true" /> : playing ? <PauseIcon /> : <PlayIcon />}
        </IconButton>
        <IconButton label="Next track" variant="quiet" size="sm" className={styles.key} onClick={onNext} disabled={!canNext}>
          <NextIcon />
        </IconButton>
      </div>

      {status === 'error' ? (
        <div className={styles.problem} role="status">
          <p className={styles.message}>{message || 'This track could not be played.'}</p>
          <Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button>
        </div>
      ) : (
        <div className={styles.seek}>
          <span className={styles.time} aria-hidden="true">{clock(shown)}</span>
          <input
            type="range"
            className={styles.range}
            style={{ '--fill': `${fill}%` } as CSSProperties}
            min={0}
            max={total ?? 0}
            step={1}
            value={Math.floor(total ? shown : 0)}
            disabled={!total}
            aria-label="Seek"
            aria-valuetext={`${clock(shown)} of ${clock(total)}`}
            onChange={(e) => setScrub(Number(e.currentTarget.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={() => setScrub(null)}
          />
          <span className={styles.time} aria-hidden="true">{clock(total)}</span>
        </div>
      )}

      <div className={styles.volume}>
        <span className={styles.volumeIcon} aria-hidden="true"><VolumeIcon /></span>
        <input
          type="range"
          className={styles.range}
          style={{ '--fill': `${Math.round(volume * 100)}%` } as CSSProperties}
          min={0}
          max={100}
          step={1}
          value={Math.round(volume * 100)}
          aria-label="Volume"
          aria-valuetext={`${Math.round(volume * 100)}%`}
          onChange={(e) => onVolume(Number(e.currentTarget.value) / 100)}
        />
      </div>

      <div className={styles.ends}>
        {onQueue && (
          <IconButton label="Queue" variant="quiet" size="sm" className={styles.key} aria-pressed={queueOpen} aria-expanded={queueOpen} data-queue-key="" onClick={onQueue}>
            <QueueIcon />
          </IconButton>
        )}
        <IconButton label="Close the player" variant="quiet" size="sm" className={styles.key} onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>

      <span className={styles.srOnly} role="status" aria-live="polite">{busy ? 'Loading' : ''}</span>
    </section>
  );
}

/**
 * The connected player: shown while a queue exists. On a desktop the bar,
 * whose queue key (and cover) opens Now Playing over the page; on a phone
 * the mini bar, which opens the full Now Playing screen. Space toggles play
 * and pause (outside fields and buttons), and it tells the page how tall it
 * is (--player-bar-h on <html>) so toasts and the floating Maintenance pill
 * sit above it. It brings back the person's queue from the server when
 * tagave opens, and hands over to the device that played last.
 */
export function PlayerBar() {
  const s = usePlayerStore();
  const player = useCapabilities().data?.player;
  const phone = useMediaQuery(PHONE_QUERY);
  const playlistsOn = usePlaylistsOn();
  const createPlaylist = useCreatePlaylist();
  const client = useQueryClient();
  // the module was removed (or the library has none): nothing to play through
  const uninstalled = !!player && !player.installed;
  useEffect(() => { if (uninstalled) stop(); }, [uninstalled]);
  const installed = player?.installed === true;
  const hasQueue = !!s.queue && s.queue.tracks.length > 0 && !uninstalled;
  const ref = useRef<HTMLDivElement>(null);
  const [nowOpen, setNowOpen] = useState(false);
  const [historyWanted, setHistoryWanted] = useState(false);
  const history = usePlayHistory(installed && nowOpen && historyWanted);
  useEffect(() => { if (!hasQueue) setNowOpen(false); }, [hasQueue]);
  // another page: Now Playing gives way to it
  const { pathname } = useLocation();
  useEffect(() => { setNowOpen(false); }, [pathname]);

  // the queue as the person left it (on this or another device), and the hand-over
  useEffect(() => {
    if (!installed) return;
    void restoreQueue();
    const look = () => { if (document.visibilityState === 'visible') void checkHandover(); };
    const timer = setInterval(look, 15_000);
    document.addEventListener('visibilitychange', look);
    window.addEventListener('focus', look);
    window.addEventListener('pagehide', persistOnLeave);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', look);
      window.removeEventListener('focus', look);
      window.removeEventListener('pagehide', persistOnLeave);
    };
  }, [installed]);

  useEffect(() => {
    if (!hasQueue) return;
    const onKey = (e: KeyboardEvent) => {
      if (!spaceTogglesPlayback(e, e.target as Element | null, true)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasQueue]);

  useEffect(() => {
    const root = globalThis.document?.documentElement;
    const node = ref.current;
    if (!root || !node || !hasQueue) return;
    root.dataset['playerBar'] = '';
    // unrounded: the sidebar's account row takes this height and must share
    // the bar's top edge to the sub-pixel
    const write = () => root.style.setProperty('--player-bar-h', `${node.getBoundingClientRect().height}px`);
    write();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(write) : null;
    ro?.observe(node);
    return () => {
      ro?.disconnect();
      delete root.dataset['playerBar'];
      root.style.removeProperty('--player-bar-h');
    };
  }, [hasQueue, phone]);

  if (!s.queue || !hasQueue) return null;
  const tracks = s.queue.tracks;
  const track = currentTrack(s) ?? tracks[0]!;
  const close = () => {
    setNowOpen(false);
    (ref.current?.querySelector('[data-queue-key], [data-mini-open]') as HTMLElement | null)?.focus();
  };
  const canNext = s.index >= 0 && nextPlayable(tracks, s.index) >= 0;
  const queueProps = {
    tracks,
    index: s.index,
    context: s.queue.context,
    onPlay: playAt,
    onMove: moveInQueue,
    onRemove: removeFromQueue,
    onClear: clearQueue,
    history: history.data ?? (historyWanted ? null : []),
    onHistoryOpen: () => { setHistoryWanted(true); void client.invalidateQueries({ queryKey: playHistoryKey }); },
    onPlayHistory: (h: PlayHistoryEntry) => {
      if (!h.localTrackId) return;
      void enqueue({ trackIds: [h.localTrackId] }, 'next').then((n) => { if (n > 0) next(); });
    },
    onSave: playlistsOn ? async (name: string) => {
      await createPlaylist.mutateAsync({ name, trackIds: tracks.map((t) => t.localTrackId) });
      showToast({ message: `Saved as ${name}` });
    } : undefined,
  };
  const actions = (
    <TrackActions
      label={`More for ${track.title}`}
      place="header"
      summary={{ title: track.title, subtitle: `${track.artist} · ${track.album}`, coverUrl: track.coverUrl }}
      source={{ trackIds: [track.localTrackId] }}
      albumId={track.albumId}
      artist={linkedArtists(track.artist, track.albumArtist, track.artists)?.[0] ?? null}
    />
  );
  const barArtist = track.artist || track.albumArtist;
  return (
    <div ref={ref} className={styles.dock} data-player-bar="">
      {phone ? (
        <>
          <MiniPlayer
            track={track}
            status={s.status}
            message={s.message}
            position={s.position}
            duration={s.duration}
            canNext={canNext}
            onOpen={() => setNowOpen(true)}
            onToggle={toggle}
            onNext={next}
            onRetry={retry}
          />
          {nowOpen && (
            <NowPlayingScreen
              {...queueProps}
              track={track}
              status={s.status}
              position={s.position}
              duration={s.duration}
              canPrevious={s.index >= 0}
              canNext={canNext}
              onToggle={toggle}
              onPrevious={previous}
              onNext={next}
              onSeek={seek}
              onClose={close}
              onNavigate={() => setNowOpen(false)}
              actions={actions}
            />
          )}
        </>
      ) : (
        <>
          {nowOpen && <NowPlayingView {...queueProps} track={track} onClose={close} onNavigate={() => setNowOpen(false)} actions={actions} />}
          <PlayerBarView
            title={track.title}
            artist={barArtist}
            album={track.album}
            artists={linkedArtists(barArtist, track.albumArtist, track.artists)}
            albumId={track.albumId}
            coverUrl={track.coverUrl}
            status={s.status}
            message={s.message}
            position={s.position}
            duration={s.duration}
            volume={s.volume}
            // Previous always has somewhere to go once a track is loaded: it restarts the first one
            canPrevious={s.index >= 0}
            canNext={canNext}
            onToggle={toggle}
            onPrevious={previous}
            onNext={next}
            onSeek={seek}
            onVolume={setVolume}
            onRetry={retry}
            onClose={() => stop({ forget: true })}
            queueOpen={nowOpen}
            onQueue={() => setNowOpen((o) => !o)}
          />
        </>
      )}
    </div>
  );
}
