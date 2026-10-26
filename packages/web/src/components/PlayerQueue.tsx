/**
 * The play queue, opened from the player bar: the album's tracks in play
 * order, the playing one marked, the ones still to come movable (up, down)
 * and removable. A row plays its track. It says where the music plays:
 * this device (tagave never hands playback to another one).
 */
import { useEffect, useRef } from 'react';
import type { PlayerQueueTrack } from '@tagave/shared';
import { IconButton, CloseIcon, ChevronUpIcon, ChevronDownIcon } from './ui';
import { clock } from '../player/logic';
import { AlbumLink, ArtistLinks, linkedArtists, lineReset, type CreditedArtist } from './NowPlayingLinks';
import styles from './PlayerQueue.module.css';

export interface PlayerQueueViewProps {
  album: string;
  /** the album's id, its credited name and artists (with ids): the album and artist names become links to their pages */
  albumId?: string | null | undefined;
  albumArtist?: string;
  artists?: readonly CreditedArtist[] | null | undefined;
  tracks: readonly PlayerQueueTrack[];
  /** the playing track's place */
  index: number;
  onPlay: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onClose: () => void;
  /** a link was followed (the bar closes the queue, so the page shows) */
  onNavigate?: (() => void) | undefined;
}

const REASON: Record<string, string> = {
  not_scanned: 'Not on the player yet',
  no_file: 'File missing',
  cue: 'Inside a CUE image',
};

export function PlayerQueueView({ album, albumId, albumArtist = '', artists, tracks, index, onPlay, onMove, onRemove, onClose, onNavigate }: PlayerQueueViewProps) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const last = tracks.length - 1;
  const upcoming = Math.max(0, tracks.length - index - 1);
  return (
    <section
      ref={ref}
      className={styles.panel}
      aria-labelledby="player-queue-title"
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <header className={styles.head}>
        <div className={styles.headText}>
          <h3 id="player-queue-title" className={styles.title}>Queue</h3>
          <p className={styles.where}>Playing on this device · {upcoming === 0 ? 'nothing after this' : `${upcoming} to come`}</p>
        </div>
        <IconButton label="Close the queue" variant="quiet" size="sm" onClick={onClose}><CloseIcon /></IconButton>
      </header>
      <p className={styles.album} dir="auto" {...lineReset}>{albumId ? <AlbumLink albumId={albumId} onNavigate={onNavigate}>{album}</AlbumLink> : album}</p>
      <ol className={styles.list}>
        {tracks.map((t, i) => {
          const state = i < index ? 'played' : i === index ? 'current' : 'next';
          const canMove = state === 'next';
          const linked = state !== 'current' && t.available ? linkedArtists(t.artist, albumArtist, artists) : null;
          return (
            <li key={`${t.localTrackId}-${i}`} className={styles.row} data-state={state} data-available={t.available ? undefined : 'no'}>
              {/* the button plays the track; the artist line sits over its second row, beside it (a link cannot be inside a button) */}
              <span className={styles.cell}>
                <button
                  type="button"
                  className={styles.main}
                  onClick={() => { if (state !== 'current') onPlay(i); }}
                  disabled={!t.available}
                  aria-current={state === 'current' ? 'true' : undefined}
                >
                  <span className={styles.no} aria-hidden="true">{state === 'current' ? <span className={styles.nowMark} /> : t.trackNo ?? i + 1}</span>
                  <span className={styles.trackTitle} dir="auto">{t.title}</span>
                  <span className={styles.time}>{t.durationMs ? clock(t.durationMs / 1000) : ''}</span>
                </button>
                <span className={styles.sub} dir="auto" {...lineReset}>
                  {state === 'current' ? 'Now playing' : !t.available ? REASON[t.reason ?? ''] ?? 'Cannot be played' : linked ? <ArtistLinks artists={linked} onNavigate={onNavigate} /> : t.artist}
                </span>
              </span>
              {canMove && (
                <span className={styles.tools}>
                  <IconButton label={`Move ${t.title} up`} variant="quiet" size="sm" disabled={i === index + 1} onClick={() => onMove(i, i - 1)}><ChevronUpIcon /></IconButton>
                  <IconButton label={`Move ${t.title} down`} variant="quiet" size="sm" disabled={i === last} onClick={() => onMove(i, i + 1)}><ChevronDownIcon /></IconButton>
                  <IconButton label={`Remove ${t.title} from the queue`} variant="quiet" size="sm" onClick={() => onRemove(i)}><CloseIcon /></IconButton>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
