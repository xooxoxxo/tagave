import type { Ref } from 'react';
import styles from './SlidingPill.module.css';

/**
 * The moving bubble of a tab strip or segmented control (useSlidingIndicator
 * places and animates it). Three parts, so it moves with transforms alone:
 * two round caps that only translate and a middle band that stretches. The
 * middle comes last so it covers the inner halves of the caps.
 */
export function SlidingPill({ ref }: { ref: Ref<HTMLSpanElement> }) {
  return <span ref={ref} className={styles.pill} aria-hidden="true">
    <span className={styles.cap} data-part="left" />
    <span className={styles.cap} data-part="right" />
    <span className={styles.mid} data-part="mid" />
  </span>;
}
