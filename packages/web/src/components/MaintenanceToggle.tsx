import { IconButton } from './ui';
import { useMaintenance } from '../maintenance';
import styles from './MaintenanceToggle.module.css';

/**
 * Maintenance lives where it changes something: the album page (its header
 * actions, and the phone top bar there). Shift+M and Settings › Appearance
 * switch it anywhere; elsewhere a "Maintenance on" pill says it is on.
 */
export function MaintenanceToggle({ className }: { className?: string | undefined }) {
  const [on, setOn] = useMaintenance();
  return (
    <IconButton
      label={on ? 'Turn off Maintenance' : 'Turn on Maintenance'}
      title={on ? 'Maintenance is on: curation tools are showing (Shift+M)' : 'Maintenance: show curation tools (Shift+M)'}
      aria-pressed={on}
      variant="quiet"
      className={`${styles.toggle} ${on ? styles.on : ''} ${className ?? ''}`}
      onClick={() => setOn(!on)}
    >
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7V20h3.3l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.5 2.5-2.4-.6-.6-2.4Z" /></svg>
    </IconButton>
  );
}

/** While Maintenance is on, a small persistent note on pages without the toggle. */
export function MaintenancePill({ className }: { className?: string | undefined }) {
  const [on, setOn] = useMaintenance();
  if (!on) return null;
  return (
    <div className={`${styles.pill} ${className ?? ''}`} role="status">
      <span className={styles.pillDot} aria-hidden="true" />
      <span>Maintenance on</span>
      <span aria-hidden="true" className={styles.pillSep}>·</span>
      <button type="button" className={styles.pillOff} onClick={() => setOn(false)}>Turn off</button>
    </div>
  );
}
