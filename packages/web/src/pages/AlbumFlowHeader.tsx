/**
 * The album page's header (vault spec "tagave - Album Page Flow"; changes
 * 2026-10-16 evening, conventions): back on the left, ⋮ on the right, as
 * embossed icons (EmbossIconButton, place "header": no circle, no key box,
 * no hover outline, a focus ring). The icons never move: their centres sit
 * 36px from the edges and 32px down at rest and docked.
 *
 * Docked, a band rises behind them and the names arrive in the middle: the
 * album title over the artist, gliding in from where the shrinking lines met
 * the header's lower edge. back | title | ⋮. Play never docks here.
 *
 * The artist page draws the same header with its kind line ("Band") over
 * the name, and Maintenance as its right-hand icon.
 */
import type { CSSProperties, ReactNode } from 'react';
import { BackIcon, EmbossIconButton, WrenchIcon } from '../components/ui';
import { maintenanceLabel } from './albumActions';
import styles from './AlbumFlowHeader.module.css';

export interface AlbumFlowHeaderProps {
  docked: boolean;
  /** the small line (the album's artist; the artist page's kind line) */
  artist: string;
  /** the main line (the album title; the artist's name) */
  title: string;
  /** the main line on top (the album page), or the small line on top (the artist page) */
  titleFirst?: boolean;
  /** where the shrinking lines met the header, relative to the title's spot */
  glide: { x: number; y: number };
  backLabel: string | null;
  onBack: () => void;
  /** the title: back to the top of the page */
  onTop: () => void;
  /** the title's accessible name (the artist page draws this header too) */
  topLabel?: string;
  /** the right-hand icon: the album's ⋮ */
  end?: ReactNode;
  /** without `end`: a Maintenance switch on the right (the artist page), for library care */
  maintenance?: boolean;
  onToggleMaintenance?: (() => void) | undefined;
}

export const maintenanceKeyLabel = maintenanceLabel;

export function AlbumFlowHeader({ docked, artist, title, titleFirst = true, glide, backLabel, onBack, onTop, topLabel = 'Back to the top of the album', end, maintenance = false, onToggleMaintenance }: AlbumFlowHeaderProps) {
  const small = <span key="a" className={styles.titleA} data-header-artist="">{artist}</span>;
  const main = <span key="b" className={styles.titleB} data-header-title="" dir="auto">{title}</span>;
  return (
    <div className={`${styles.header} ${docked ? styles.docked : ''}`} data-album-header="" data-docked={docked ? '' : undefined}>
      <div className={styles.box}>
        <div className={styles.band} aria-hidden="true" />
        {backLabel && (
          <span className={`${styles.slot} ${styles.start}`}>
            <EmbossIconButton place="header" label={backLabel} onClick={onBack} data-header-back="">
              <BackIcon />
            </EmbossIconButton>
          </span>
        )}
        <button
          type="button"
          className={styles.mid}
          aria-label={topLabel}
          data-top-key=""
          tabIndex={docked ? 0 : -1}
          aria-hidden={docked ? undefined : true}
          onClick={onTop}
        >
          <span className={`${styles.title} ${titleFirst ? '' : styles.smallFirst}`} style={{ '--glide-x': `${glide.x}px`, '--glide-y': `${glide.y}px` } as CSSProperties}>
            {titleFirst ? [main, small] : [small, main]}
          </span>
        </button>
        <span className={`${styles.slot} ${styles.end}`} data-header-end="">
          {end ?? (onToggleMaintenance && (
            <EmbossIconButton
              place="header"
              label={maintenanceLabel(maintenance)}
              aria-pressed={maintenance}
              title={maintenance ? 'Maintenance is on: curation tools are showing (Shift+M)' : 'Maintenance: show curation tools (Shift+M)'}
              onClick={onToggleMaintenance}
            >
              <WrenchIcon />
            </EmbossIconButton>
          ))}
        </span>
      </div>
    </div>
  );
}
