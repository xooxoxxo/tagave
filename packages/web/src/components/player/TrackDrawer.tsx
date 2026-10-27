/**
 * The ⋮ as a drawer (a phone or a touch screen), and Add to playlist… on
 * its own: the album drawer's summary, tiles and rows; "Add to playlist"
 * turns the drawer into the list of playlists. Loaded the first time one
 * opens, so the drawer library is not in the app's first chunk.
 */
import type { ReactNode, RefObject } from 'react';
import { BackIcon, CoverArt, EmbossIconButton } from '../ui';
import { Sheet } from '../ui/Sheet';
import type { QueueSource } from '../../player/engine';
import { PlaylistChoices } from './PlaylistChoices';
import drawer from '../../pages/AlbumMenu.module.css';
import styles from './TrackActions.module.css';

export interface DrawerRow { key: string; label: string; icon: ReactNode; tone?: 'danger' | undefined; tile: boolean; onSelect: () => void }

export interface TrackDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLElement | null>;
  summary: { title: string; subtitle: string; coverUrl: string | null };
  rows: readonly DrawerRow[];
  step: 'actions' | 'playlists';
  onStep: (step: 'actions' | 'playlists') => void;
  source: QueueSource;
}

export function TrackDrawer({ open, onOpenChange, returnFocus, summary, rows, step, onStep, source }: TrackDrawerProps) {
  const tiles = rows.filter((r) => r.tile);
  const list = rows.filter((r) => !r.tile);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`${summary.title}: more`} returnFocus={returnFocus}>
      <div className={drawer.sheet}>
        {step === 'actions' ? (
          <>
            <div className={drawer.head}>
              <CoverArt src={summary.coverUrl} title={summary.title} compact className={drawer.thumb} />
              <div className={drawer.headText}>
                <p className={drawer.headTitle} dir="auto">{summary.title}</p>
                <p className={drawer.headArtist} dir="auto">{summary.subtitle}</p>
              </div>
            </div>
            {tiles.length > 0 && (
              <ul className={drawer.tiles} data-count={tiles.length}>
                {tiles.map((r) => (
                  <li key={r.key}><button type="button" className={drawer.tile} onClick={r.onSelect}><span className={drawer.tileIcon}>{r.icon}</span><span className={drawer.tileLabel}>{r.label}</span></button></li>
                ))}
              </ul>
            )}
            {list.length > 0 && (
              <ul className={drawer.rows}>
                {list.map((r) => (
                  <li key={r.key}>
                    <button type="button" className={`${drawer.row} ${r.tone === 'danger' ? styles.danger : ''}`} onClick={r.onSelect}>
                      <span className={drawer.rowIcon}>{r.icon}</span>
                      <span className={drawer.rowText}><span className={drawer.rowLabel}>{r.label}</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <div className={styles.stepHead}>
              <EmbossIconButton label="Back" onClick={() => onStep('actions')}><BackIcon /></EmbossIconButton>
              <span className={styles.stepTitle}>Add to playlist</span>
            </div>
            <PlaylistChoices source={source} variant="drawer" onDone={() => onOpenChange(false)} />
          </>
        )}
      </div>
    </Sheet>
  );
}

/** Add to playlist… on its own (the album's ⋮): a drawer on a phone, a side sheet on a desktop. */
export function AddToPlaylistSheet({ open, onOpenChange, source, side, returnFocus }: {
  open: boolean; onOpenChange: (open: boolean) => void; source: QueueSource; side: 'bottom' | 'right'; returnFocus?: RefObject<HTMLElement | null>;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Add to playlist" side={side} returnFocus={returnFocus}>
      <div className={drawer.sheet}>
        <div className={styles.stepHead}><span className={styles.stepTitle}>Add to playlist</span></div>
        <PlaylistChoices source={source} variant="drawer" onDone={() => onOpenChange(false)} />
      </div>
    </Sheet>
  );
}
