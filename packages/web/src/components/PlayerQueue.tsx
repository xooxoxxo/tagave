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
import styles from './PlayerQueue.module.css';

export interface PlayerQueueViewProps {
  album: string;
  tracks: readonly PlayerQueueTrack[];
  /** the playing track's place */
  index: number;
  onPlay: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onClose: () => void;
}

const REASON: Record<string, string> = {
  not_scanned: 'Not on the player yet',
  no_file: 'File missing',
  cue: 'Inside a CUE image',
};

export function PlayerQueueView({ album, tracks, index, onPlay, onMove, onRemove, onClose }: PlayerQueueViewProps) {
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
          <h2 id="player-queue-title" className={styles.title}>Queue</h2>
          <p className={styles.where}>Playing on this device · {upcoming === 0 ? 'nothing after this' : `${upcoming} to come`}</p>
        </div>
        <IconButton label="Close the queue" variant="quiet" size="sm" onClick={onClose}><CloseIcon /></IconButton>
      </header>
      <p className={styles.album} dir="auto">{album}</p>
      <ol className={styles.list}>
        {tracks.map((t, i) => {
          const state = i < index ? 'played' : i === index ? 'current' : 'next';
          const canMove = state === 'next';
          return (
            <li key={`${t.localTrackId}-${i}`} className={styles.row} data-state={state} data-available={t.available ? undefined : 'no'}>
              <button
                type="button"
                className={styles.main}
                onClick={() => onPlay(i)}
                disabled={!t.available || state === 'current'}
                aria-current={state === 'current' ? 'true' : undefined}
              >
                <span className={styles.no} aria-hidden="true">{state === 'current' ? <span className={styles.nowMark} /> : t.trackNo ?? i + 1}</span>
                <span className={styles.names}>
                  <span className={styles.trackTitle} dir="auto">{t.title}</span>
                  <span className={styles.sub} dir="auto">{state === 'current' ? 'Now playing' : t.available ? t.artist : REASON[t.reason ?? ''] ?? 'Cannot be played'}</span>
                </span>
                <span className={styles.time}>{t.durationMs ? clock(t.durationMs / 1000) : ''}</span>
              </button>
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
