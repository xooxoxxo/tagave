/**
 * "Mix": shown in the player bar while the DJ module fades one track into
 * the next. Two small bars trade places over the fade (the outgoing one
 * sinks, the incoming one rises, along the equal-power curve); transform and
 * opacity only, timed by CSS from the fade's length, so nothing renders per
 * frame. Mounted mid-fade (a page change), it picks up where the fade is.
 */
import type { CSSProperties } from 'react';
import styles from './MixChip.module.css';

export interface MixChipProps {
  /** the fade's length */
  lengthMs: number;
  /** when it began (Date.now()); omitted: now */
  at?: number;
  /** the stories hold it at one point of the fade (0..1) */
  frozenAt?: number;
}

export function MixChip({ lengthMs, at, frozenAt }: MixChipProps) {
  const elapsed = frozenAt != null ? frozenAt * lengthMs : at != null ? Math.max(0, Date.now() - at) : 0;
  const style = { '--mix-len': `${Math.max(200, lengthMs)}ms`, '--mix-delay': `${-Math.min(elapsed, lengthMs)}ms` } as CSSProperties;
  return (
    <span className={styles.mix} style={style} data-frozen={frozenAt != null ? '' : undefined} role="status">
      <span className={styles.bars} aria-hidden="true"><i className={styles.out} /><i className={styles.in} /></span>
      Mix
    </span>
  );
}
