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
 * Checks that did not pass, in full (what was found and how to fix it);
 * the ones that passed fold into one "All good · N" line that opens.
 */
export function SystemCheckList({ checks }: { checks: SystemCheck[] }) {
  const ok = checks.filter((c) => c.status === 'pass');
  const rest = checks.filter((c) => c.status !== 'pass');
  return (
    <>
      {rest.length > 0 && <CheckRows checks={rest} />}
      {ok.length > 0 && (
        <details className={styles.ok}>
          <summary>{rest.length === 0 ? 'All good' : 'OK'} · {ok.length}</summary>
          <CheckRows checks={ok} />
        </details>
      )}
    </>
  );
}

function CheckRows({ checks }: { checks: SystemCheck[] }) {
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
              <p className={styles.fix}>{check.remediation}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
