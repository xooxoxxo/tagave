/**
 * The album page's header (vault spec "tagave - Album Page Flow", rules 6-10).
 *
 * Back (left) and Maintenance (right) never move: their icons sit 36px from
 * the edge and 32px down at every scroll depth. At rest they are raised
 * round 44px keys; docked, the header lifts around them (a dark cavity, no
 * border) and three touching keys fill it: back | artist + album |
 * Maintenance. Pressed, a key hinges at its top edge and its bottom tips in,
 * like a cassette deck's transport keys.
 *
 * Rule 8 amended (2026-10-16): once the album's action strip has scrolled
 * under the header, Play docks as a fourth key between the title and
 * Maintenance: back | artist + album | ▶ | Maintenance. It follows the
 * strip's Play (disabled while the player waits, Pause while playing).
 */
import type { CSSProperties, PointerEvent } from 'react';
import { PauseIcon, PlayIcon } from '../components/ui';
import type { AlbumPlayState } from './albumActions';
import styles from './AlbumFlowHeader.module.css';

export interface AlbumFlowHeaderProps {
  docked: boolean;
  artist: string;
  title: string;
  /** where the shrinking lines met the header, relative to the title's spot in the middle key */
  glide: { x: number; y: number };
  backLabel: string | null;
  onBack: () => void;
  /** the middle key: back to the top of the album */
  onTop: () => void;
  /** the middle key's accessible name (the artist page draws this header too) */
  topLabel?: string;
  maintenance: boolean;
  /** Absent for a role without library care: the key keeps its place, unseen. */
  onToggleMaintenance?: (() => void) | undefined;
  /** the album's Play, when a player is installed: it docks here once the strip is under the header */
  play?: AlbumPlayState | null | undefined;
  /** the action strip has scrolled under the header */
  playDocked?: boolean;
  /** the id of the line saying why Play waits */
  playNoteId?: string | undefined;
}

/** Touch shows the press too (:active is unreliable on some touch browsers). */
export function pressHandlers(pressedClass: string) {
  const on = (e: { currentTarget: { classList: { add(c: string): void } } }) => e.currentTarget.classList.add(pressedClass);
  const off = (e: { currentTarget: { classList: { remove(c: string): void } } }) => e.currentTarget.classList.remove(pressedClass);
  return {
    onPointerDown: on as (e: PointerEvent<HTMLButtonElement>) => void,
    onPointerUp: off as (e: PointerEvent<HTMLButtonElement>) => void,
    onPointerLeave: off as (e: PointerEvent<HTMLButtonElement>) => void,
    onPointerCancel: off as (e: PointerEvent<HTMLButtonElement>) => void,
  };
}

export const maintenanceKeyLabel = (on: boolean) => (on ? 'Turn off Maintenance' : 'Turn on Maintenance');

export function AlbumFlowHeader({ docked, artist, title, glide, backLabel, onBack, onTop, topLabel = 'Back to the top of the album', maintenance, onToggleMaintenance, play = null, playDocked = false, playNoteId }: AlbumFlowHeaderProps) {
  const press = pressHandlers(styles.pressed!);
  const playIn = !!play && docked && playDocked;
  const playing = play?.mode === 'pause';
  const playWaits = !!play?.disabled && play.mode === 'play';
  const playLabel = playing ? 'Pause' : play?.mode === 'resume' ? 'Resume' : 'Play';
  return (
    <div className={`${styles.header} ${docked ? styles.docked : ''} ${playIn ? styles.playDocked : ''}`} data-album-header="" data-docked={docked ? '' : undefined} data-play-docked={playIn ? '' : undefined}>
      <div className={styles.box}>
        <div className={styles.cavity} aria-hidden="true" />
        {backLabel && (
          <button type="button" className={`${styles.key} ${styles.backKey}`} aria-label={backLabel} title={backLabel} onClick={onBack} {...press}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" /></svg>
          </button>
        )}
        <button
          type="button"
          className={styles.midKey}
          aria-label={topLabel}
          data-top-key=""
          tabIndex={docked ? 0 : -1}
          aria-hidden={docked ? undefined : true}
          onClick={onTop}
          {...press}
        >
          <span className={styles.title} style={{ '--glide-x': `${glide.x}px`, '--glide-y': `${glide.y}px` } as CSSProperties}>
            <span className={styles.titleA} data-header-artist="">{artist}</span>
            <span className={styles.titleB} dir="auto">{title}</span>
          </span>
        </button>
        {play && (
          <button
            type="button"
            className={styles.playKey}
            data-header-play=""
            aria-label={playLabel}
            title={playLabel}
            tabIndex={playIn ? 0 : -1}
            aria-hidden={playIn ? undefined : true}
            disabled={playWaits}
            aria-busy={play.loading || undefined}
            aria-describedby={playWaits && playNoteId && play.note ? playNoteId : undefined}
            onClick={play.loading ? undefined : play.mode === 'play' ? play.onPlay : play.onToggle}
            {...press}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
            <span className={styles.playText}>{playWaits && play.waitText ? play.waitText : playLabel}</span>
          </button>
        )}
        <button
          type="button"
          className={`${styles.key} ${styles.maintKey} ${maintenance ? styles.on : ''}`}
          // a listener has no Maintenance: the key holds the header's balance only
          {...(onToggleMaintenance ? {} : { style: { visibility: 'hidden' as const }, tabIndex: -1, 'aria-hidden': true, disabled: true })}
          aria-label={maintenanceKeyLabel(maintenance)}
          aria-pressed={maintenance}
          title={maintenance ? 'Maintenance is on: curation tools are showing (Shift+M)' : 'Maintenance: show curation tools (Shift+M)'}
          onClick={onToggleMaintenance}
          {...press}
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.6 3.4a4 4 0 0 0-4.9 5.2L3.5 12.8a1.6 1.6 0 0 0 2.3 2.3l4.2-4.2a4 4 0 0 0 5.2-4.9l-2.3 2.3-2-.4-.4-2z" /></svg>
        </button>
      </div>
    </div>
  );
}
