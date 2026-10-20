/**
 * Settings › Backups: one grouped list per kind of database dump (nightly,
 * before update, manual, and before restore when there is one). Each kind's
 * settings are rows with one compact select on the right, saved as soon as
 * they change; under them, that kind's backups: date · version · size · ⋯
 * (Download, Copy restore command, Delete). "Back up now" and the totals sit
 * on top, the folder and how to restore at the foot.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackupEntryView, BackupKindSummaryView, BackupKindView, BackupSettingsView, BackupsStatus } from '@tagave/shared';
import { Badge, Banner, Button, Menu, Select, Surface, confirmDialog, showToast } from '../components/ui';
import { backupDownloadUrl, useBackUpNow, useBackups, useDeleteBackup, useSaveBackupSettings } from '../hooks/useBackups';
import { formatBytes } from '../utils/format';
import { shortDate } from '../utils/time';
import { docsUrl } from '../utils/docs';
import { copyText } from './AlbumFolders';
import styles from './SettingsBackupsPage.module.css';

const KIND_LABEL: Record<BackupKindView, string> = {
  nightly: 'Nightly',
  'pre-migration': 'Before update',
  manual: 'Manual',
  'pre-restore': 'Before restore',
};

const when = (iso: string) => shortDate(iso);
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The choices of a count select: a short ladder, plus the saved value when it is not on it. */
function ladder(values: number[], current: number | null): number[] {
  const set = new Set(values);
  if (current !== null) set.add(current);
  return [...set].sort((a, b) => a - b);
}

/** "0.11.0", "~0.10.0" (worked out from the update history) or "—". */
export function versionLabel(b: Pick<BackupEntryView, 'version' | 'versionInferred'>): string {
  if (!b.version) return '—';
  return `${b.versionInferred ? '~' : ''}${b.version}`;
}

function versionTitle(b: BackupEntryView): string | undefined {
  if (!b.version) return 'Version unknown';
  return b.versionInferred ? 'From the update history' : undefined;
}

function download(name: string) {
  const a = document.createElement('a');
  a.href = backupDownloadUrl(name);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function Row({ label, title, children }: { label: string; title?: string | undefined; children: ReactNode }) {
  return (
    <label className={styles.row}>
      <span className={styles.rowLabel} title={title}>{label}</span>
      {children}
    </label>
  );
}

function BackupRow({ b, expires, restoreCommand, onDelete, deleting }: { b: BackupEntryView; expires: boolean; restoreCommand: string; onDelete: (b: BackupEntryView) => void; deleting: boolean }) {
  return (
    <li className={styles.item}>
      <span className={styles.date}>
        <span title={b.name}>{when(b.createdAt)}</span>
        {expires && <Badge className={`${styles.expires}`}>Expires</Badge>}
        {b.verified === false && <span className={styles.bad} title="The file changed size after it was written">Changed since</span>}
      </span>
      <span className={styles.meta}>
        <span className={styles.version} title={versionTitle(b)}>
          {versionLabel(b)}
          {b.toVersion && <span className={styles.to}> → {b.toVersion}</span>}
        </span>
        <span className={styles.size}>{formatBytes(b.bytes)}</span>
      </span>
      <Menu
        size="sm"
        label={`More for the backup of ${when(b.createdAt)}`}
        items={[
          { key: 'download', label: 'Download', onSelect: () => download(b.name) },
          {
            key: 'restore',
            label: 'Copy restore command',
            onSelect: () => {
              void copyText(restoreCommand.replaceAll('{file}', b.name)).then((ok) =>
                showToast(ok ? { message: 'Copied', durationMs: 2000 } : { message: 'Could not copy', tone: 'danger', durationMs: 3500 }),
              );
            },
          },
          { key: 'delete', label: 'Delete', tone: 'danger', separated: true, disabled: deleting, onSelect: () => onDelete(b) },
        ]}
      />
    </li>
  );
}

type SaveState = 'saved' | 'error' | null;

function Group({ kind, summary, backups, status, save, restoreCommand, onDelete, deleting, children }: {
  kind: BackupKindView;
  summary: BackupKindSummaryView | undefined;
  backups: BackupEntryView[];
  status: SaveState;
  save?: string | null;
  restoreCommand: string;
  onDelete: (b: BackupEntryView) => void;
  deleting: boolean;
  children?: ReactNode;
}) {
  const list = backups.filter((b) => b.kind === kind);
  const expiring = new Set(summary?.pendingDelete.names ?? []);
  return (
    <section className={styles.group} aria-label={KIND_LABEL[kind]}>
      <div className={styles.groupHead}>
        <h3 className={styles.groupTitle}>{KIND_LABEL[kind]}</h3>
        {status === 'saved' && <span className={styles.saved} role="status">✓ Saved</span>}
        {status === 'error' && <span className={styles.bad} role="alert">{save ?? 'Not saved'}</span>}
        {list.length > 0 && <span className={styles.groupMeta}>{list.length} · {formatBytes(list.reduce((s, b) => s + b.bytes, 0))}</span>}
      </div>
      {children && <Surface padded={false} className={styles.list}>{children}</Surface>}
      {list.length > 0 && (
        <Surface padded={false} className={styles.list}>
          <ul className={styles.items}>
            {list.map((b) => <BackupRow key={b.name} b={b} expires={expiring.has(b.name)} restoreCommand={restoreCommand} onDelete={onDelete} deleting={deleting} />)}
          </ul>
        </Surface>
      )}
    </section>
  );
}

const GROUP_OF: Record<keyof BackupSettingsView, BackupKindView> = {
  enabled: 'nightly', hour: 'nightly', keepDaily: 'nightly', keepWeekly: 'nightly', keepPreUpdate: 'pre-migration', keepManual: 'manual',
};

export function SettingsBackupsPage() {
  const { data, isLoading, error } = useBackups();
  if (isLoading) return <p className={styles.muted}>Loading backups…</p>;
  if (error || !data) return <Banner tone="danger">Couldn’t load backups.</Banner>;
  return <Backups data={data} />;
}

function Backups({ data }: { data: BackupsStatus }) {
  const backUp = useBackUpNow();
  const remove = useDeleteBackup();
  const save = useSaveBackupSettings();
  // The value shown while its save is on its way; cleared when the answer comes.
  const [pending, setPending] = useState<BackupSettingsView | null>(null);
  const [state, setState] = useState<{ kind: BackupKindView; status: SaveState; detail: string | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const settings = pending ?? data.settings;
  const kind = (k: BackupKindView) => data.kinds.find((s) => s.kind === k);
  const lastNight = data.lastNightly;
  const lastManualFailed = data.lastRun && !data.lastRun.ok && data.lastRun.kind === 'manual' ? data.lastRun : null;

  /** Save one changed setting at once; "✓ Saved" on its group for a moment, or why it was not. */
  const change = (patch: Partial<BackupSettingsView>) => {
    const next = { ...settings, ...patch };
    const group = GROUP_OF[Object.keys(patch)[0] as keyof BackupSettingsView];
    setPending(next);
    clearTimeout(timer.current);
    setState(null);
    save.mutate(next, {
      onSuccess: () => {
        setPending(null);
        setState({ kind: group, status: 'saved', detail: null });
        timer.current = setTimeout(() => setState(null), 2500);
      },
      onError: (err) => {
        setPending(null);
        setState({ kind: group, status: 'error', detail: (err as { detail?: string }).detail ?? null });
      },
    });
  };

  const onDelete = async (b: BackupEntryView) => {
    const ok = await confirmDialog({
      title: 'Delete this backup?',
      message: <><code>{b.name}</code>. This cannot be undone.</>,
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (ok) remove.mutate(b.name);
  };

  const status = (k: BackupKindView): SaveState => (state?.kind === k ? state.status : null);
  const detail = (k: BackupKindView) => (state?.kind === k ? state.detail : null);
  const common = { backups: data.backups, restoreCommand: data.restoreCommand, onDelete: (b: BackupEntryView) => void onDelete(b), deleting: remove.isPending };

  return (
    <div className={styles.page}>
      {lastNight && !lastNight.ok && (
        <Banner tone="danger">Nightly backup {when(lastNight.startedAt)} failed: {lastNight.error}</Banner>
      )}
      {lastManualFailed && (
        <Banner tone="danger">Backup {when(lastManualFailed.startedAt)} failed: {lastManualFailed.error}</Banner>
      )}
      {!data.dedicated && (
        <Banner tone="warning">
          Backups are in the cache folder (<code>{data.dir}</code>). Set <code>BACKUP_DIR</code>.
        </Banner>
      )}
      {data.error && <Banner tone="danger">{data.error}</Banner>}
      {backUp.error && <Banner tone="danger">Could not start the backup.</Banner>}

      <div className={styles.top}>
        <span className={styles.muted}>
          {data.backups.length === 0 ? 'No backups yet' : `${data.backups.length} · ${formatBytes(data.totalBytes)}`}
        </span>
        <Button size="sm" onClick={() => backUp.mutate()} loading={data.running || backUp.isPending} disabled={data.running}>
          {data.running ? 'Backing up…' : 'Back up now'}
        </Button>
      </div>

      <Group kind="nightly" summary={kind('nightly')} status={status('nightly')} save={detail('nightly')} {...common}>
        <Row label="Time" title={data.timeZone}>
          <Select
            dense
            className={styles.control}
            value={settings.enabled ? String(settings.hour) : 'off'}
            onChange={(e) => change(e.target.value === 'off' ? { enabled: false } : { enabled: true, hour: parseInt(e.target.value, 10) })}
          >
            <option value="off">Off</option>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </Select>
        </Row>
        <Row label="Daily">
          <Select dense className={styles.control} value={settings.keepDaily} onChange={(e) => change({ keepDaily: parseInt(e.target.value, 10) })}>
            {ladder([1, 2, 3, 5, 7, 10, 14, 30, 60, 90], settings.keepDaily).map((n) => <option key={n} value={n}>{plural(n, 'day')}</option>)}
          </Select>
        </Row>
        <Row label="Weekly">
          <Select dense className={styles.control} value={settings.keepWeekly} onChange={(e) => change({ keepWeekly: parseInt(e.target.value, 10) })}>
            {ladder([0, 1, 2, 4, 8, 12, 26, 52], settings.keepWeekly).map((n) => <option key={n} value={n}>{n === 0 ? 'None' : plural(n, 'week')}</option>)}
          </Select>
        </Row>
      </Group>

      <Group kind="pre-migration" summary={kind('pre-migration')} status={status('pre-migration')} save={detail('pre-migration')} {...common}>
        <Row label="Keep">
          <Select dense className={styles.control} value={settings.keepPreUpdate} onChange={(e) => change({ keepPreUpdate: parseInt(e.target.value, 10) })}>
            {ladder([1, 2, 3, 5, 10, 20, 50], settings.keepPreUpdate).map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </Row>
      </Group>

      <Group kind="manual" summary={kind('manual')} status={status('manual')} save={detail('manual')} {...common}>
        <Row label="Keep">
          <Select
            dense
            className={styles.control}
            value={settings.keepManual === null ? 'all' : String(settings.keepManual)}
            onChange={(e) => change({ keepManual: e.target.value === 'all' ? null : parseInt(e.target.value, 10) })}
          >
            <option value="all">All</option>
            {ladder([1, 2, 3, 5, 10, 20, 50, 100], settings.keepManual).map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </Row>
      </Group>

      {kind('pre-restore') && <Group kind="pre-restore" summary={kind('pre-restore')} status={null} {...common} />}

      <p className={styles.muted}>
        <code>{data.dir}</code> · <a href={docsUrl('operations.md#restore-a-backup')} target="_blank" rel="noreferrer">How to restore</a>
      </p>
    </div>
  );
}
