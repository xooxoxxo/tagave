/**
 * Settings page navigation - small sub-nav for settings pages
 */
import { Link } from '@tanstack/react-router';
import { useCurrentLibrary } from '../hooks/useCurrentLibrary';
import { useUpdates } from '../hooks/useUpdates';
import styles from './SettingsNav.module.css';

export function SettingsNav() {
  return (
    <div className={styles.nav}>
      <Link to="/onboarding" className={styles.link} activeProps={{ className: styles.active }}>
        Setup checklist
      </Link>
      <Link to="/settings/scan-roots" className={styles.link} activeProps={{ className: styles.active }}>
        Scan roots
      </Link>
      <Link to="/settings/providers" className={styles.link} activeProps={{ className: styles.active }}>
        Providers
      </Link>
      <Link to="/settings/genres" className={styles.link} activeProps={{ className: styles.active }}>
        Genres
      </Link>
      <Link to="/settings/follow-rules" className={styles.link} activeProps={{ className: styles.active }}>
        Follow Rules
      </Link>
      <Link to="/settings/updates" className={styles.link} activeProps={{ className: styles.active }}>
        Updates<UpdateDot />
      </Link>
    </div>
  );
}

/** "Update available" marker (spec XO-313); cheap query, shared with the page. */
function UpdateDot() {
  const { libraryId } = useCurrentLibrary();
  const { data } = useUpdates(libraryId);
  if (!data?.updateAvailable && !data?.mismatch) return null;
  return <span className={styles.dot} title={data.updateAvailable ? 'Update available' : 'Worker build differs from the app'} />;
}
