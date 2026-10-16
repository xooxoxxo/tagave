/**
 * The album's ⋮ (changes 2026-10-16 evening: conventions, like a music
 * app's album menu). On a phone or tablet (≤ 900px) it opens a bottom
 * drawer: the album's summary, quick-action tiles, a list of rows, the
 * Maintenance tools while Maintenance is on, and the Maintenance switch for
 * library care. On a desktop the same items are a dropdown (Menu). The items
 * come from albumMenu() in albumActions.ts.
 *
 * The drawers themselves (AlbumSheets.tsx) load when one first opens.
 */
import { useSyncExternalStore, type ReactNode } from 'react';
import { CoverArt, DiscIcon, EmbossIconButton, InfoIcon, KebabIcon, Menu, PersonIcon, ShuffleIcon, WrenchIcon, embossClassName, type EmbossPlace } from '../components/ui';
import { albumMenuItems, type AlbumMenuAction, type AlbumMenuIcon, type AlbumMenuModel } from './albumActions';
import styles from './AlbumMenu.module.css';

/** The drawer's width: phones and tablets; wider screens get the dropdown. */
export const DRAWER_QUERY = '(max-width: 900px)';
const media = () => globalThis.matchMedia?.(DRAWER_QUERY) ?? null;
const subscribe = (cb: () => void) => {
  const m = media();
  m?.addEventListener?.('change', cb);
  return () => m?.removeEventListener?.('change', cb);
};
/** Whether ⋮ opens the drawer (true) or the dropdown (false), following the window. */
export function useAlbumDrawer(): boolean {
  return useSyncExternalStore(subscribe, () => !!media()?.matches, () => false);
}

const ICONS: Record<AlbumMenuIcon, () => ReactNode> = {
  shuffle: ShuffleIcon,
  artist: PersonIcon,
  disc: DiscIcon,
  info: InfoIcon,
  tool: WrenchIcon,
  maintenance: WrenchIcon,
};
const Icon = ({ name }: { name: AlbumMenuIcon }) => { const C = ICONS[name]; return <>{C()}</>; };

export const MORE_LABEL = 'More for this album';

export interface AlbumMoreButtonProps {
  place: EmbossPlace;
  model: AlbumMenuModel;
  /** drawer layout: open the drawer, focus returns to this button */
  drawer: boolean;
  open?: boolean;
  onOpen: (button: HTMLButtonElement) => void;
}

/** ⋮: opens the drawer on a phone, a dropdown on a desktop. */
export function AlbumMoreButton({ place, model, drawer, open = false, onOpen }: AlbumMoreButtonProps) {
  if (!drawer) {
    return <Menu label={MORE_LABEL} items={albumMenuItems(model)} triggerClassName={embossClassName(place)} icon={<KebabIcon />} />;
  }
  return (
    <EmbossIconButton place={place} label={MORE_LABEL} aria-haspopup="dialog" aria-expanded={open} data-album-more="" onClick={(e) => onOpen(e.currentTarget)}>
      <KebabIcon />
    </EmbossIconButton>
  );
}

export interface AlbumSummary {
  coverUrl: string | null;
  title: string;
  artist: string;
  /** "Rock · 2012" */
  kicker: string[];
  /** a short format badge ("FLAC 16-bit/44.1 kHz") */
  format?: string | null | undefined;
}

/** The album's summary at the top of both drawers: thumb, title, artist, "Genre · Year", format. */
export function AlbumSummaryHead({ summary }: { summary: AlbumSummary }) {
  return (
    <div className={styles.head} data-album-summary-head="">
      <CoverArt src={summary.coverUrl} title={summary.title} compact className={styles.thumb} />
      <div className={styles.headText}>
        <p className={styles.headTitle} dir="auto">{summary.title}</p>
        <p className={styles.headArtist}>{summary.artist}</p>
        {(summary.kicker.length > 0 || summary.format) && (
          <p className={styles.headMeta}>
            {summary.kicker.length > 0 && <span>{summary.kicker.join(' · ')}</span>}
            {summary.format && <span className={styles.badge}>{summary.format}</span>}
          </p>
        )}
      </div>
    </div>
  );
}

/** What the ⋮ drawer holds: the summary, tiles, rows, the tools, the Maintenance switch. */
export function AlbumActionsBody({ summary, model, onClose }: { summary: AlbumSummary; model: AlbumMenuModel; onClose: () => void }) {
  const pick = (a: AlbumMenuAction) => {
    if (a.disabled) return;
    onClose();
    a.onSelect();
  };
  const row = (a: AlbumMenuAction) => (
    <li key={a.key}>
      <button type="button" className={styles.row} disabled={a.disabled} onClick={() => pick(a)} data-menu-row={a.key}>
        <span className={styles.rowIcon} aria-hidden="true"><Icon name={a.icon} /></span>
        <span className={styles.rowText}>
          <span className={styles.rowLabel}>{a.label}</span>
          {a.hint && <span className={styles.rowHint}>{a.hint}</span>}
        </span>
      </button>
    </li>
  );
  const m = model.maintenance;
  return (
    <>
      <div className={styles.sheet} data-album-actions-sheet="">
        <AlbumSummaryHead summary={summary} />
        {model.tiles.length > 0 && (
          <ul className={styles.tiles} data-count={model.tiles.length}>
            {model.tiles.map((a) => (
              <li key={a.key}>
                <button type="button" className={styles.tile} disabled={a.disabled} onClick={() => pick(a)} title={a.hint ?? a.label} data-menu-tile={a.key}>
                  <span className={styles.tileIcon} aria-hidden="true"><Icon name={a.icon} /></span>
                  <span className={styles.tileLabel}>{a.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <ul className={styles.rows}>{model.rows.map(row)}</ul>
        {model.tools.length > 0 && (
          <section className={styles.group} aria-labelledby="album-tools-heading">
            <h2 id="album-tools-heading" className={styles.groupTitle}>Maintenance tools</h2>
            <ul className={styles.rows}>{model.tools.map(row)}</ul>
          </section>
        )}
        {m && (
          <div className={styles.group}>
            <button
              type="button"
              className={`${styles.row} ${styles.switchRow}`}
              aria-pressed={m.on}
              aria-label="Maintenance"
              onClick={() => { onClose(); m.onToggle(); }}
              data-menu-row="mode"
            >
              <span className={styles.rowIcon} aria-hidden="true"><WrenchIcon /></span>
              <span className={styles.rowText}>
                <span className={styles.rowLabel}>Maintenance</span>
                <span className={styles.rowHint}>{m.on ? 'Match state, library issues and tools are showing' : 'Show match state, library issues and tools'}</span>
              </span>
              <span className={styles.state} aria-hidden="true">{m.on ? 'On' : 'Off'}</span>
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export interface AlbumInfoTab { value: string; label: string; content: ReactNode }

