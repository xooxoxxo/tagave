/**
 * The DJ view (Advanced mode, vault "tagave - DJ Module"; direction B of the
 * prototype): two decks side by side (stacked on a phone), the crossfader,
 * then the queue. Auto mix Off/On in the header. Labels and values only.
 * Driven by props (stories); pages/DjPage.tsx connects it.
 */
import type { ReactNode } from 'react';
import type { DeckIndex, DecksState } from '../../player/djDecks';
import { BackIcon, EmbossIconButton, Fader, SegmentedControl } from '../ui';
import { Deck, type DeckHandlers } from './Deck';
import styles from './DjView.module.css';

export interface DjViewProps {
  state: Pick<DecksState, 'x' | 'heard' | 'decks'>;
  position: (i: DeckIndex) => number;
  deck: (i: DeckIndex) => DeckHandlers;
  onCrossfader: (x: number) => void;
  /** the queue (QueuePanel) */
  queue?: ReactNode;
}

const ON_OFF = [{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }];

/** "A 71 · B 71" (equal power). */
export function crossfaderText(x: number): string {
  const a = Math.round(Math.cos((x * Math.PI) / 2) * 100);
  const b = Math.round(Math.sin((x * Math.PI) / 2) * 100);
  return `A ${a} % · B ${b} %`;
}

/** The view's header: Close, "DJ", Auto mix Off/On (PageShell's hero). */
export function DjHead({ auto, onAuto, onClose }: { auto?: boolean; onAuto?: ((on: boolean) => void) | undefined; onClose: () => void }) {
  return (
    <div className={styles.head}>
      <EmbossIconButton label="Close DJ" place="header" onClick={onClose}><BackIcon /></EmbossIconButton>
      <h1 className={styles.heading}>DJ</h1>
      {onAuto && (
        <div className={styles.auto}>
          <span className={styles.ctlLabel} aria-hidden="true">Auto mix</span>
          <SegmentedControl label="Auto mix" size="sm" value={auto ? 'on' : 'off'} onChange={(v) => onAuto(v === 'on')} options={ON_OFF} />
        </div>
      )}
    </div>
  );
}

/** The decks, the crossfader and the queue (inside the page's PageShell, under DjHead). */
export function DjView({ state, position, deck, onCrossfader, queue }: DjViewProps) {
  return (
    <div className={styles.body}>
      <div className={styles.decks}>
        {([0, 1] as const).map((i) => (
          <Deck key={i} letter={i === 0 ? 'A' : 'B'} deck={state.decks[i]} heard={state.heard === i} position={() => position(i)} {...deck(i)} />
        ))}
      </div>
      <div className={styles.crossfader}>
        <Fader label="Crossfader" value={state.x} min={0} max={1} step={0.005} defaultValue={0.5} format={crossfaderText} onChange={onCrossfader} start="A" end="B" />
      </div>
      {queue && (
        <section className={styles.queue} aria-label="Queue">
          <h2 className={styles.queueTitle}>Queue</h2>
          {queue}
        </section>
      )}
    </div>
  );
}

/** The route when the view cannot run here: one label, one value. */
export function DjUnavailable({ value }: { value: string }) {
  return (
    <div className={styles.field}>
      <span className={styles.ctlLabel}>DJ</span>
      <span className={styles.fieldValue} role="status">{value}</span>
    </div>
  );
}
