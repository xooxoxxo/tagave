/**
 * Settings › Status › System status: the same checks as `tagave-doctor`,
 * each with what was found and, when it did not pass, how to fix it, as one
 * group (spec §6): the check time in its head, Recheck in a row, the list
 * under it. Checks run on the app host against the shared database, so
 * worker results cover every host of a split install. Music folders are
 * those of the library on screen (useSystemChecks sends its id), not every
 * library in the database.
 */
import { Banner, Button, SettingsGroup, SettingsRow } from '../../components/ui';
import { SystemCheckList } from '../../components/SystemCheckList';
import { useSystemChecks, type SystemChecksResponse } from '../../hooks/useSystem';
import { shortDate } from '../../utils/time';
import styles from './SystemStatus.module.css';

/** "12 of 14 passed" */
export function checksValue(checks: Array<{ status: string }>): string {
  const passed = checks.filter((c) => c.status === 'pass').length;
  return `${passed} of ${checks.length} passed`;
}

export interface SystemStatusViewProps {
  data: SystemChecksResponse | null | undefined;
  loading?: boolean;
  failed?: boolean;
  checking?: boolean;
  onRecheck: () => void;
}

/** The group alone, driven by props (stories, tests). */
export function SystemStatusView({ data, loading = false, failed = false, checking = false, onRecheck }: SystemStatusViewProps) {
  return (
    <SettingsGroup
      title="System status"
      meta={data ? shortDate(data.checkedAt) : null}
      after={<>
        {failed && <Banner tone="danger">Checks could not run. Check that Postgres is running.</Banner>}
        {data && <SystemCheckList checks={data.checks} />}
      </>}
    >
      <SettingsRow as="div" label="Checks" value={<span className={styles.value} role="status">{loading ? 'Running' : data ? checksValue(data.checks) : 'Not run'}</span>}>
        <Button variant="secondary" size="sm" onClick={onRecheck} loading={checking}>Recheck</Button>
      </SettingsRow>
    </SettingsGroup>
  );
}

export function SystemStatus() {
  const { data, isLoading, isError, isFetching, refetch } = useSystemChecks({ refetchInterval: 60_000 });
  return <SystemStatusView data={data} loading={isLoading} failed={isError} checking={isFetching} onRecheck={() => void refetch()} />;
}
