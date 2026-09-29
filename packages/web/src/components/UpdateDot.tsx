import styles from './UpdateDot.module.css';

/**
 * The quiet "a new version is out" dot on the Settings nav item and the
 * Updates section link. Only the library owner can see update status, so
 * nobody else ever gets it.
 */
export function UpdateDot() {
  return (
    <span className={styles.dot} title="A new version is available">
      <span className={styles.srOnly}> (a new version is available)</span>
    </span>
  );
}
