/**
 * The album's Play, its ⋯ menu and, when Play has to wait, one quiet line
 * saying why: a compact row in the title area (owner, 2026-10-15: Play
 * "pushes the tracklist all the way down" when it sat in its own block).
 */
import type { ReactNode } from 'react';
import { Button, PauseIcon, PlayIcon, type ButtonVariant } from '../components/ui';
import styles from './AlbumPlayRow.module.css';

export interface AlbumPlayRowProps {
  /** what the button does; null when no player is installed (only the menu shows) */
  mode: 'play' | 'pause' | 'resume' | null;
  /** primary, unless a decision above already holds the view's primary */
  variant?: ButtonVariant;
  /** the album's queue is on its way */
  loading?: boolean;
  /** Play has to wait (the note says why) */
  disabled?: boolean;
  /** why Play waits: "On the player after its first scan (34 %)" */
  note?: string | null;
  onPlay?: () => void;
  onToggle?: () => void;
  /** the ⋯ menu, when it lives here (outside Maintenance) */
  menu?: ReactNode;
}

const NOTE_ID = 'album-play-note';

export function AlbumPlayRow({ mode, variant = 'primary', loading = false, disabled = false, note = null, onPlay, onToggle, menu }: AlbumPlayRowProps) {
  if (!mode && !menu) return null;
  return (
    <div className={styles.row}>
      {mode === 'pause' ? (
        <Button variant={variant} size="sm" className={styles.play} data-album-play="" onClick={onToggle}><PauseIcon />Pause</Button>
      ) : mode === 'resume' ? (
        <Button variant={variant} size="sm" className={styles.play} data-album-play="" onClick={onToggle}><PlayIcon />Resume</Button>
      ) : mode === 'play' ? (
        <Button
          variant={variant}
          size="sm"
          className={styles.play}
          data-album-play=""
          loading={loading}
          disabled={disabled}
          aria-describedby={note ? NOTE_ID : undefined}
          onClick={onPlay}
        >
          <PlayIcon />Play
        </Button>
      ) : null}
      {menu}
      {mode && note && <p id={NOTE_ID} className={styles.note}>{note}</p>}
    </div>
  );
}
