/**
 * The album's actions: one strip of touching transport keys in the header
 * keys' style (vault spec "tagave - Album Page Flow", changes 2026-10-16,
 * direction B "Transport"). The keys come from a slot list (albumActions.ts):
 * Shuffle | Play | ⋯. Play is icon only and fills the room between the two
 * side keys, which are as wide as each other, so on a phone it sits on the
 * screen's centre line at every width. A side slot with nothing in it keeps
 * its width and draws nothing. Pressed, a key hinges at its top edge like a
 * cassette deck's transport key (rule 10).
 *
 * When Play has to wait, one quiet line under the strip says why.
 */
import { useSyncExternalStore, type CSSProperties, type Ref } from 'react';
import { Menu, PauseIcon, PlayIcon, ShuffleIcon, type MenuItem } from '../components/ui';
import { pressHandlers } from './AlbumFlowHeader';
import { SLOTS, playLabel, stripColumns, stripSlots, type AlbumActionContext, type AlbumActionId, type AlbumPlayState, type StripLayout } from './albumActions';
import styles from './AlbumActionStrip.module.css';

export type { AlbumPlayState };

export const PLAY_NOTE_ID = 'album-play-note';

/** The album page's phone layout (the same width as its CSS and useAlbumFlow). */
const PHONE_QUERY = '(max-width: 720px)';
const phoneMedia = () => globalThis.matchMedia?.(PHONE_QUERY) ?? null;
const subscribePhone = (cb: () => void) => {
  const m = phoneMedia();
  m?.addEventListener?.('change', cb);
  return () => m?.removeEventListener?.('change', cb);
};

/** Which slot list the strip reads: the phone's or the desktop's, following the window. */
export function useStripLayout(): StripLayout {
  return useSyncExternalStore(subscribePhone, () => (phoneMedia()?.matches ? 'phone' : 'desk'), () => 'desk');
}

export interface AlbumActionStripProps {
  layout: StripLayout;
  /** who can do what here (albumActionContext) */
  context: AlbumActionContext;
  /** Play's state; absent without a player */
  play?: AlbumPlayState | null;
  /** the ⋯ menu's items (its key shows when the context says the menu is there) */
  menu?: { label: string; items: MenuItem[] } | null;
  /** the slot list; SLOTS[layout] unless a person's own list is given */
  slots?: readonly AlbumActionId[];
  stripRef?: Ref<HTMLDivElement>;
}

/** Three small bars that rise and fall while the album plays (still with reduced motion). */
export function PlayingBars({ className }: { className?: string }) {
  return <span className={[styles.bars, className].filter(Boolean).join(' ')} aria-hidden="true"><i /><i /><i /></span>;
}

export function AlbumActionStrip({ layout, context, play = null, menu = null, slots, stripRef }: AlbumActionStripProps) {
  const list = slots ?? SLOTS[layout];
  const cells = stripSlots(list, { ...context, player: context.player && !!play, menu: context.menu && !!menu && menu.items.length > 0 });
  const note = play?.note ?? null;
  if (!cells) return null;
  const press = pressHandlers(styles.pressed!);
  const runClass = (s: { runStart: boolean; runEnd: boolean }) => [s.runStart ? styles.runStart : '', s.runEnd ? styles.runEnd : ''].filter(Boolean).join(' ');
  const hasPlay = cells.some((c) => c.id === 'play' && c.filled);
  const waiting = !!play?.disabled && play.mode === 'play';
  const busy = !!play?.loading;

  const playKey = (cls: string) => {
    if (!play) return null;
    const label = playLabel(play.mode);
    return (
      <button
        type="button"
        className={`${styles.key} ${styles.play} ${cls}`}
        data-album-play=""
        aria-label={label}
        title={label}
        disabled={waiting}
        aria-busy={busy || undefined}
        aria-describedby={note ? PLAY_NOTE_ID : undefined}
        onClick={busy ? undefined : play.mode === 'play' ? play.onPlay : play.onToggle}
        {...press}
      >
        {busy && play.mode === 'play' ? <span className={styles.spinner} aria-hidden="true" />
          : play.mode === 'pause' ? <><PauseIcon /><PlayingBars /></>
            : <PlayIcon />}
      </button>
    );
  };

  const shuffleKey = (cls: string) => (
    <button
      type="button"
      className={`${styles.key} ${cls}`}
      data-album-shuffle=""
      aria-label="Shuffle"
      title="Shuffle: play the album in a random order"
      disabled={waiting}
      aria-describedby={waiting && note ? PLAY_NOTE_ID : undefined}
      onClick={busy ? undefined : play?.onShuffle}
      {...press}
    >
      <ShuffleIcon />
    </button>
  );

  return (
    <>
      <div
        ref={stripRef}
        className={`${styles.strip} ${layout === 'desk' ? styles.desk : ''} ${hasPlay ? '' : styles.keysOnly}`}
        style={{ gridTemplateColumns: hasPlay ? stripColumns(list, layout) : stripColumns(cells.map((c) => c.id), layout) } as CSSProperties}
        role="group"
        aria-label="Album actions"
        data-album-strip={layout}
      >
        {cells.map((s) => {
          const cls = runClass(s);
          if (!s.filled) return <div key={s.id} className={styles.space} data-slot={s.id} data-empty="" aria-hidden="true" />;
          if (s.id === 'play') return <div key={s.id} className={styles.slot} data-slot="play">{playKey(cls)}</div>;
          if (s.id === 'shuffle' && play) return <div key={s.id} className={styles.slot} data-slot="shuffle">{shuffleKey(cls)}</div>;
          if (s.id === 'more' && menu) {
            return (
              <div key={s.id} className={styles.slot} data-slot="more">
                <Menu label={menu.label} items={menu.items} className={styles.menuAnchor!} triggerClassName={`${styles.key} ${cls}`} triggerProps={press} />
              </div>
            );
          }
          // a shipped action without a key of its own yet draws nothing (never a dead button)
          return <div key={s.id} className={styles.space} data-slot={s.id} data-empty="" aria-hidden="true" />;
        })}
      </div>
      {play && note && <p id={PLAY_NOTE_ID} className={styles.note}>{note}</p>}
    </>
  );
}
