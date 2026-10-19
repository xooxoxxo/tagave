/**
 * Settings › Backups: every database dump in the backups folder (nightly,
 * manual, before an update, before a restore), "Back up now", download and
 * delete, the nightly schedule, how many of each kind are kept, and where
 * the files live and how to get a copy off this computer.
 */
import { useState } from 'react';
import type { BackupEntryView, BackupKindSummaryView, BackupKindView, BackupSettingsView } from '@tagave/shared';
import { Badge, Banner, Button, Input, SegmentedControl, Select, buttonClassName, confirmDialog, type BadgeTone } from '../components/ui';
import { backupDownloadUrl, useBackUpNow, useBackups, useDeleteBackup, useSaveBackupSettings } from '../hooks/useBackups';
import { formatBytes } from '../utils/format';
import { shortDate } from '../utils/time';
import { docsUrl } from '../utils/docs';
import styles from './SettingsBackupsPage.module.css';

const KIND: Record<BackupKindView, { label: string; tone: BadgeTone }> = {
  nightly: { label: 'Nightly', tone: 'neutral' },
  manual: { label: 'Manual', tone: 'info' },
  'pre-migration': { label: 'Before update', tone: 'accent' },
  'pre-restore': { label: 'Before restore', tone: 'warning' },
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const when = (iso: string) => shortDate(iso);

function hourLabel(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 backups, 1.2 GB, newest 16 Oct 2026, 03:00" for one kind. */
function kindSummary(k: BackupKindSummaryView | undefined): string {
  if (!k || k.count === 0) return 'None';
  return `${plural(k.count, 'backup')} · ${formatBytes(k.bytes)}`;
}

/**
 * What the next run of a kind deletes under the saved settings (D5: lowering
 * a number deletes nothing on save). The dates are the ones in the list above.
 */
function PendingDelete({ kind, backups, edited }: { kind: BackupKindSummaryView | undefined; backups: BackupEntryView[]; edited: boolean }) {
  if (edited) return null;
  if (!kind || kind.pendingDelete.count === 0) return null;
  const byName = new Map(backups.map((b) => [b.name, b]));
  const dates = kind.pendingDelete.names.map((n) => byName.get(n)).filter((b): b is BackupEntryView => !!b);
  const shown = dates.slice(0, 3).map((b) => when(b.createdAt));
  const more = dates.length - shown.length;
  return (
    <p className={styles.hint}>
      Next run deletes {plural(kind.pendingDelete.count, 'older backup')} ({formatBytes(kind.pendingDelete.bytes)}):{' '}
      <span title={kind.pendingDelete.names.join('\n')}>{shown.join('; ')}{more > 0 ? `; and ${more} more` : ''}</span>
    </p>
  );
}


export function SettingsBackupsPage() {
  const { data, isLoading, error } = useBackups();
  const backUp = useBackUpNow();
  const remove = useDeleteBackup();
  const save = useSaveBackupSettings();
  // Unsaved edits to the schedule; null while the form shows what is saved.
  const [edits, setEdits] = useState<BackupSettingsView | null>(null);

  if (isLoading) return <p className={styles.muted}>Loading backups…</p>;
  if (error || !data) return <Banner tone="danger">Couldn’t load backups.</Banner>;

  const draft = edits ?? data.settings;
  const setDraft = (next: BackupSettingsView) => setEdits(next);
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const lastNight = data.lastNightly;
  const lastManualFailed = data.lastRun && !data.lastRun.ok && data.lastRun.kind === 'manual' ? data.lastRun : null;

  const onDelete = async (b: BackupEntryView) => {
    const ok = await confirmDialog({
      title: 'Delete this backup?',
      message: <><code>{b.name}</code>. This cannot be undone.</>,
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (ok) remove.mutate(b.name);
  };

  const setNumber = (field: 'keepDaily' | 'keepWeekly' | 'keepPreUpdate' | 'keepManual', raw: string, min: number, max: number) => {
    const n = parseInt(raw, 10);
    setDraft({ ...draft, [field]: Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : min });
  };
  const saved = data.settings;
  const kinds = data.kinds;
  const kind = (k: BackupKindView) => kinds.find((b) => b.kind === k);
  const nightlyEdited = draft.enabled !== saved.enabled || draft.hour !== saved.hour || draft.keepDaily !== saved.keepDaily || draft.keepWeekly !== saved.keepWeekly;
  const restore = kind('pre-restore');

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

      <section className={styles.section} aria-label="Backups">
        <div className={styles.head}>
          <Button onClick={() => backUp.mutate()} loading={data.running || backUp.isPending} disabled={data.running}>
            {data.running ? 'Backing up…' : 'Back up now'}
          </Button>
        </div>
        {backUp.error && <Banner tone="danger">Could not start the backup.</Banner>}
        {data.backups.length === 0 ? (
          <p className={styles.muted}>No backups yet</p>
        ) : (
          <>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <tbody>
                  {data.backups.map((b) => (
                    <tr key={b.name}>
                      <td><span title={b.name}>{when(b.createdAt)}</span></td>
                      <td><Badge tone={KIND[b.kind].tone}>{KIND[b.kind].label}</Badge></td>
                      <td className={styles.num}>{formatBytes(b.bytes)}</td>
                      <td>
                        {b.verified === false && <span className={styles.bad} title="The file changed size after it was written">Changed since</span>}
                        {b.verified === null && <span className={styles.muted}>Not checked</span>}
                      </td>
                      <td className={styles.actions}>
                        <a className={buttonClassName({ variant: 'quiet', size: 'sm' })} href={backupDownloadUrl(b.name)} download={b.name}>Download</a>
                        <Button variant="quiet-danger" size="sm" onClick={() => void onDelete(b)} disabled={remove.isPending}>Delete</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={styles.muted}>
              {data.backups.length} backup{data.backups.length === 1 ? '' : 's'} · {formatBytes(data.totalBytes)} · <code>{data.dir}</code> · <a href={docsUrl('operations.md#backups')} target="_blank" rel="noreferrer">How to restore</a>
            </p>
          </>
        )}
      </section>

      <section className={styles.section} aria-label="Keeping backups">

        <h4 className={styles.subTitle}>Nightly</h4>
        <p className={styles.muted}>{kindSummary(kind('nightly'))}</p>
        <div className={styles.fields}>
          <div className={styles.field}>
            <SegmentedControl label="Nightly backup" value={draft.enabled ? 'on' : 'off'} onChange={(v) => setDraft({ ...draft, enabled: v === 'on' })} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
          </div>
          <label className={styles.field}>
            <span className={styles.label}>Time ({data.timeZone})</span>
            <Select value={draft.hour} disabled={!draft.enabled} onChange={(e) => setDraft({ ...draft, hour: parseInt(e.target.value, 10) })}>
              {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </Select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Days</span>
            <Input type="number" inputMode="numeric" min={1} max={90} value={draft.keepDaily} onChange={(e) => setNumber('keepDaily', e.target.value, 1, 90)} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Weeks</span>
            <Input type="number" inputMode="numeric" min={0} max={52} value={draft.keepWeekly} onChange={(e) => setNumber('keepWeekly', e.target.value, 0, 52)} />
          </label>
        </div>

        <PendingDelete kind={kind('nightly')} backups={data.backups} edited={nightlyEdited} />

        <h4 className={styles.subTitle}>Before update</h4>
        <p className={styles.muted}>{kindSummary(kind('pre-migration'))}</p>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.label}>Keep</span>
            <Input type="number" inputMode="numeric" min={1} max={50} value={draft.keepPreUpdate} onChange={(e) => setNumber('keepPreUpdate', e.target.value, 1, 50)} />
          </label>
        </div>

        <PendingDelete kind={kind('pre-migration')} backups={data.backups} edited={draft.keepPreUpdate !== saved.keepPreUpdate} />

        <h4 className={styles.subTitle}>Manual</h4>
        <p className={styles.muted}>{kindSummary(kind('manual'))}</p>
        <div className={styles.fields}>
          <div className={styles.field}>
            <span className={styles.label}>Keep</span>
            <SegmentedControl
              label="Keep manual backups"
              value={draft.keepManual === null ? 'all' : 'newest'}
              onChange={(v) => setDraft({ ...draft, keepManual: v === 'all' ? null : (saved.keepManual ?? Math.max(1, kind('manual')?.count ?? 1)) })}
              options={[{ value: 'all', label: 'All' }, { value: 'newest', label: 'Newest' }]}
            />
          </div>
          <label className={styles.field}>
            <span className={styles.label}>Count</span>
            <Input type="number" inputMode="numeric" min={1} max={100} disabled={draft.keepManual === null} value={draft.keepManual ?? ''} onChange={(e) => setNumber('keepManual', e.target.value, 1, 100)} />
          </label>
        </div>

        <PendingDelete kind={kind('manual')} backups={data.backups} edited={draft.keepManual !== saved.keepManual} />

        {restore && (
          <>
            <h4 className={styles.subTitle}>Before restore</h4>
            <p className={styles.muted}>{kindSummary(restore)}</p>

          </>
        )}

        <div className={styles.row}>
          <Button onClick={() => save.mutate(draft, { onSuccess: () => setEdits(null) })} disabled={!dirty} loading={save.isPending}>Save</Button>
          {dirty && <Button variant="quiet" onClick={() => setEdits(null)}>Cancel</Button>}
          {save.error && <span className={styles.bad}>{(save.error as { detail?: string }).detail ?? 'Could not save.'}</span>}
        </div>
      </section>

    </div>
  );
}
