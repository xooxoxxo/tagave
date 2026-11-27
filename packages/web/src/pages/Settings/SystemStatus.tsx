/**
 * Settings › Status › System status: the same checks as `tagave-doctor`,
 * each with what was found and, when it did not pass, how to fix it, as one
 * group (spec §6): the check time in its head, Recheck in a row, the list
 * under it. Checks run on the app host against the shared database, so
 * worker results cover every host of a split install. Music folders are
 * those of the library on screen (useSystemChecks sends its id), not every
 * library in the database.
 *
 * With the updater, the music share's fstab line adds rows (spec section
 * 11): "Music share at boot" when it has no nofail (a problem, the
 * suggested line behind "?"), "Music share mount" for a soft mount (a
 * note). The doctor cannot read the host, so the updater reads fstab. No
 * updater, no row.
 */
import type { MusicBoot, UpdaterView } from '@tagave/shared';
import { Banner, Button, SettingsGroup, SettingsRow } from '../../components/ui';
import { SystemCheckList } from '../../components/SystemCheckList';
import { useSystemChecks, type SystemChecksResponse } from '../../hooks/useSystem';
import { useUpdater } from '../../hooks/useUpdater';
import { shortDate } from '../../utils/time';
import styles from './SystemStatus.module.css';

/** "12 of 14 passed" */
export function checksValue(checks: Array<{ status: string }>): string {
  const passed = checks.filter((c) => c.status === 'pass').length;
  return `${passed} of ${checks.length} passed`;
}

/** The fstab line spec section 11 recommends, with the example server. */
const SUGGESTED_FSTAB_LINE = '192.0.2.10:/export/music  /mnt/music  nfs4  hard,_netdev,nofail,x-systemd.automount,x-systemd.mount-timeout=30  0 0';

/** The updater's musicBoot while it answers; null without an updater, while it does not answer, or from one too old to say. */
export function musicBootFrom(view: UpdaterView | undefined): MusicBoot | null {
  if (!view?.installed || !view.reachable) return null;
  return view.updater?.musicBoot ?? null;
}

export interface SystemStatusViewProps {
  data: SystemChecksResponse | null | undefined;
  loading?: boolean;
  failed?: boolean;
  checking?: boolean;
  onRecheck: () => void;
  /** What the updater read of the music share's fstab line; none: no rows. */
  musicBoot?: MusicBoot | null;
}

/** The group alone, driven by props (stories, tests). */
export function SystemStatusView({ data, loading = false, failed = false, checking = false, onRecheck, musicBoot = null }: SystemStatusViewProps) {
  const codes = musicBoot?.codes ?? [];
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
      {codes.includes('nofail_missing') && (
        <SettingsRow
          as="div"
          label="Music share at boot"
          help={<>
            <p className={styles.helpText}>Add nofail to the music share&apos;s line in /etc/fstab, for example:</p>
            <code className={styles.fstab}>{SUGGESTED_FSTAB_LINE}</code>
          </>}
          value={<span className={styles.problem} role="alert">may stop this computer starting while the NAS is off</span>}
        />
      )}
      {codes.includes('soft_mount') && (
        <SettingsRow
          as="div"
          label="Music share mount"
          help="A soft mount gives up when the NAS is slow, and can cut a tag write short. tagave suggests hard."
          value={<span className={styles.value}>Mounted soft</span>}
        />
      )}
    </SettingsGroup>
  );
}

export function SystemStatus() {
  const { data, isLoading, isError, isFetching, refetch } = useSystemChecks({ refetchInterval: 60_000 });
  // The same query as Settings › Updates (one poll, shared); the section is the owner's only.
  const updater = useUpdater();
  return <SystemStatusView data={data} loading={isLoading} failed={isError} checking={isFetching} onRecheck={() => void refetch()} musicBoot={musicBootFrom(updater.data)} />;
}
