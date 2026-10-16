/**
 * The album's action row (changes 2026-10-16 evening: conventions, like a
 * music app's album page): plain embossed icons around one filled Play,
 * read from the slot list (albumActions.ts): Shuffle | Play | ⋮. Play is the
 * only filled control, icon only (its word is for screen readers). A slot
 * with nothing in it keeps its width and draws nothing, so Play stays on the
 * row's centre line. While Play has to wait, one quiet line under the row
 * says why. Without a player there is no row (⋮ is in the header).
 */
import type { ReactNode, Ref } from 'react';
import { EmbossIconButton, PauseIcon, PlayIcon, ShuffleIcon } from '../components/ui';
import { SLOTS, playLabel, rowSlots, type AlbumActionContext, type AlbumActionId, type AlbumPlayState } from './albumActions';
import styles from './AlbumActionRow.module.css';

export type { AlbumPlayState };

export const PLAY_NOTE_ID = 'album-play-note';

export interface AlbumActionRowProps {
  /** who can do what here (albumActionContext) */
  context: AlbumActionContext;
  /** Play's state; absent without a player */
  play?: AlbumPlayState | null;
  /** the ⋮ button (a drawer trigger on a phone, a dropdown on a desktop) */
  more?: ReactNode;
  /** the slot list; SLOTS unless a person's own list is given */
  slots?: readonly AlbumActionId[];
  rowRef?: Ref<HTMLDivElement>;
}

/** The filled round Play: Play, Pause or Resume; a spinner while the queue loads. */
export function PlayButton({ play, noteId }: { play: AlbumPlayState; noteId?: string | undefined }) {
  const label = playLabel(play.mode);
  const waiting = !!play.disabled && play.mode === 'play';
  const busy = !!play.loading;
  return (
    <button
      type="button"
      className={styles.play}
      data-album-play=""
      aria-label={label}
      title={label}
      disabled={waiting}
      aria-busy={busy || undefined}
      aria-describedby={noteId}
      onClick={busy ? undefined : play.mode === 'play' ? play.onPlay : play.onToggle}
    >
      {busy && play.mode === 'play' ? <span className={styles.spinner} aria-hidden="true" />
        : play.mode === 'pause' ? <PauseIcon /> : <PlayIcon />}
    </button>
  );
}

export function AlbumActionRow({ context, play = null, more = null, slots, rowRef }: AlbumActionRowProps) {
  const cells = rowSlots(slots ?? SLOTS, { ...context, player: context.player && !!play, menu: context.menu && !!more });
  if (!cells || !play) return null;
  const note = play.note ?? null;
  const waiting = !!play.disabled && play.mode === 'play';
  const busy = !!play.loading;
  return (
    <div className={styles.wrap}>
      <div ref={rowRef} className={styles.row} role="group" aria-label="Album actions" data-album-actions="">
        {cells.map((s) => {
          if (!s.filled) return <span key={s.id} className={styles.space} data-slot={s.id} data-empty="" aria-hidden="true" />;
          if (s.id === 'play') {
            return <span key={s.id} className={styles.slot} data-slot="play"><PlayButton play={play} noteId={note ? PLAY_NOTE_ID : undefined} /></span>;
          }
          if (s.id === 'shuffle') {
            return (
              <span key={s.id} className={styles.slot} data-slot="shuffle">
                <EmbossIconButton
                  label="Shuffle"
                  title="Shuffle: play the album in a random order"
                  data-album-shuffle=""
                  disabled={waiting}
                  aria-describedby={waiting && note ? PLAY_NOTE_ID : undefined}
                  onClick={busy ? undefined : play.onShuffle}
                >
                  <ShuffleIcon />
                </EmbossIconButton>
              </span>
            );
          }
          if (s.id === 'more') return <span key={s.id} className={styles.slot} data-slot="more">{more}</span>;
          // a shipped action without a button of its own yet draws nothing (never a dead button)
          return <span key={s.id} className={styles.space} data-slot={s.id} data-empty="" aria-hidden="true" />;
        })}
      </div>
      {note && <p id={PLAY_NOTE_ID} className={styles.note}>{note}</p>}
    </div>
  );
}
