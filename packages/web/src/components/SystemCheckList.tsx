import { Badge, type BadgeTone } from './ui';
import type { SystemCheck } from '../pages/setupWizard';
import styles from './SystemCheckList.module.css';

const STATUS: Record<SystemCheck['status'], { label: string; tone: BadgeTone }> = {
  pass: { label: 'OK', tone: 'success' },
  warn: { label: 'Warning', tone: 'warning' },
  fail: { label: 'Failed', tone: 'danger' },
  skip: { label: 'Not checked', tone: 'neutral' },
};

/** Plain names for the doctor's check ids; the doctor's own title is the fallback. */
const TITLES: Record<string, string> = {
  database: 'Database',
  migrations: 'Database schema',
  contactString: 'Contact for metadata services',
  workerHeartbeat: 'Workers',
  versions: 'Build versions',
  scanRoots: 'Music folders',
  cacheDir: 'Cache folder',
  backups: 'Backups before updates',
  providers: 'Metadata services',
  appSecret: 'App secret',
};

/**
 * One row per check: what was checked, what was found, and, for anything
 * that did not pass, what to do about it.
 */
export function SystemCheckList({ checks }: { checks: SystemCheck[] }) {
  return (
    <ul className={styles.list}>
      {checks.map((check) => {
        const status = STATUS[check.status] ?? STATUS.skip;
        return (
          <li key={check.id} className={[styles.item, check.status === 'fail' ? styles.failed : check.status === 'warn' ? styles.warned : ''].filter(Boolean).join(' ')}>
            <div className={styles.head}>
              <span className={styles.title}>{TITLES[check.id] ?? check.title}</span>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
            {check.detail && <p className={styles.detail}>{check.detail}</p>}
            {check.remediation && (
              <p className={styles.fix}>
                <strong>How to fix: </strong>
                {check.remediation}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
