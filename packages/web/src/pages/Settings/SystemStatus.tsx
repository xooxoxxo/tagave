/**
 * Settings › System status: the same checks as `tagave-doctor`, each with
 * what was found and, when it did not pass, how to fix it. Checks run on the
 * app host against the shared database, so worker results cover every host
 * of a split install. Music folders are those of the library on screen
 * (useSystemChecks sends its id), not every library in the database.
 */
import { Banner, Button } from '../../components/ui';
import { SystemCheckList } from '../../components/SystemCheckList';
import { useSystemChecks } from '../../hooks/useSystem';
import { shortDate } from '../../utils/time';
import styles from './SystemStatus.module.css';

export function SystemStatus() {
  const { data, isLoading, isError, isFetching, refetch } = useSystemChecks({ refetchInterval: 60_000 });

  return (
    <section className={styles.section} aria-label="Health checks">
      <div className={styles.head}>
        <span className={styles.muted}>{data ? shortDate(data.checkedAt) : ''}</span>
        <Button variant="secondary" size="sm" onClick={() => void refetch()} loading={isFetching}>
          {isFetching ? 'Checking…' : 'Recheck'}
        </Button>
      </div>

      {isLoading && <p className={styles.muted} role="status">Running checks…</p>}
      {isError && (
        <Banner tone="danger">
          Checks could not run. Check that Postgres is running.
        </Banner>
      )}

      {data && (
        <>
          <SystemCheckList checks={data.checks} />
        </>
      )}
    </section>
  );
}
