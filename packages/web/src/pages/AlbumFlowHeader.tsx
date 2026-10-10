/**
 * The album page's header (vault spec "Liner - Album Page Flow", rules 6-10).
 *
 * Back (left) and Maintenance (right) never move: their icons sit 36px from
 * the edge and 32px down at every scroll depth. At rest they are raised
 * round 44px keys; docked, the header lifts around them (a dark cavity, no
 * border) and three touching keys fill it: back | artist + album |
 * Maintenance. Pressed, a key hinges at its top edge and its bottom tips in,
 * like a cassette deck's transport keys.
 */
import type { CSSProperties, PointerEvent } from 'react';
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
  maintenance: boolean;
  onToggleMaintenance: () => void;
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

export function AlbumFlowHeader({ docked, artist, title, glide, backLabel, onBack, onTop, maintenance, onToggleMaintenance }: AlbumFlowHeaderProps) {
  const press = pressHandlers(styles.pressed!);
  return (
    <div className={`${styles.header} ${docked ? styles.docked : ''}`} data-album-header="" data-docked={docked ? '' : undefined}>
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
          aria-label="Back to the top of the album"
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
        <button
          type="button"
          className={`${styles.key} ${styles.maintKey} ${maintenance ? styles.on : ''}`}
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
