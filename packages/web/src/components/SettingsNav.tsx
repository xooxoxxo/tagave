/**
 * Settings page navigation - small sub-nav for settings pages
 */
import { Link } from '@tanstack/react-router';
import styles from './SettingsNav.module.css';

export function SettingsNav() {
  return (
    <div className={styles.nav}>
      <Link to="/settings/scan-roots" className={styles.link} activeProps={{ className: styles.active }}>
        Scan roots
      </Link>
      <Link to="/settings/providers" className={styles.link} activeProps={{ className: styles.active }}>
        Providers
      </Link>
    </div>
  );
}
