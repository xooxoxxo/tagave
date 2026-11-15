/** Small shared parts of Library care › Autotagger. */
import type { ReactNode } from 'react';
import styles from './autotagger.module.css';

/** label · value pairs */
export function Values({ rows, label }: { rows: Array<[string, ReactNode]>; label?: string }) {
  return (
    <dl className={styles.values} aria-label={label}>
      {rows.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}
