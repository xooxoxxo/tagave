/**
 * Settings › System status: the same checks as `liner-doctor`, each with
 * what was found and, when it did not pass, how to fix it. Checks run on the
 * app host against the shared database, so worker and music-folder results
 * cover every host of a split install.
 */
import { Banner, Button } from '../../components/ui';
import { SystemCheckList } from '../../components/SystemCheckList';
import { useSystemChecks } from '../../hooks/useSystem';
import styles from './SystemStatus.module.css';

export function SystemStatus() {
  const { data, isLoading, isError, isFetching, refetch } = useSystemChecks({ refetchInterval: 60_000 });
  const failed = data?.checks.filter((c) => c.status === 'fail').length ?? 0;
  const warned = data?.checks.filter((c) => c.status === 'warn').length ?? 0;

  return (
    <section className={styles.section} aria-labelledby="checks-heading">
      <div className={styles.head}>
        <h3 id="checks-heading" className={styles.title}>Health checks</h3>
        <Button variant="secondary" size="sm" onClick={() => void refetch()} loading={isFetching}>
          {isFetching ? 'Checking…' : 'Check again'}
        </Button>
      </div>

      {isLoading && <p className={styles.muted} role="status">Running checks…</p>}
      {isError && (
        <Banner tone="danger">
          The checks could not run. If this keeps happening, the app may have lost its database: check that Postgres is
          running and that DATABASE_URL is right.
        </Banner>
      )}

      {data && (
        <>
          <Banner tone={failed ? 'danger' : warned ? 'warning' : 'success'}>
            {failed
              ? `${failed} ${failed === 1 ? 'check needs' : 'checks need'} attention. Each one says how to fix it.`
              : warned
                ? `Everything works. ${warned} ${warned === 1 ? 'warning is' : 'warnings are'} worth a look.`
                : 'Everything is working.'}
          </Banner>
          <SystemCheckList checks={data.checks} />
          <p className={styles.muted}>
            Checked {new Date(data.checkedAt).toLocaleString()}. The same checks run from a shell with{' '}
            <code>liner-doctor doctor</code>.
          </p>
        </>
      )}
    </section>
  );
}
