/**
 * Settings › Backups: every database dump in the backups folder (nightly,
 * manual, before an update, before a restore), "Back up now", download and
 * delete, the nightly schedule and how many are kept, and where the files
 * live and how to get a copy off this computer.
 */
import { useState } from 'react';
import type { BackupEntryView, BackupKindView, BackupSettingsView } from '@liner/shared';
import { Badge, Banner, Button, Input, SegmentedControl, Select, buttonClassName, confirmDialog, type BadgeTone } from '../components/ui';
import { backupDownloadUrl, useBackUpNow, useBackups, useDeleteBackup, useSaveBackupSettings } from '../hooks/useBackups';
import { formatBytes } from '../utils/format';
import styles from './SettingsBackupsPage.module.css';

const KIND: Record<BackupKindView, { label: string; tone: BadgeTone }> = {
  nightly: { label: 'Nightly', tone: 'neutral' },
  manual: { label: 'Manual', tone: 'info' },
  'pre-migration': { label: 'Before update', tone: 'accent' },
  'pre-restore': { label: 'Before restore', tone: 'warning' },
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function hourLabel(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

const COPY_CMD = 'cd ~/tagave\ndocker compose cp app:/backups ./tagave-backups';
const RESTORE_CMD = [
  'cd ~/tagave',
  'docker compose stop app worker-identify worker-files',
  'docker compose run --rm --no-deps app node packages/doctor/dist/cli.js restore <file name> --yes',
  'docker compose up -d',
].join('\n');

export function SettingsBackupsPage() {
  const { data, isLoading, error } = useBackups();
  const backUp = useBackUpNow();
  const remove = useDeleteBackup();
  const save = useSaveBackupSettings();
  // Unsaved edits to the schedule; null while the form shows what is saved.
  const [edits, setEdits] = useState<BackupSettingsView | null>(null);

  if (isLoading) return <p className={styles.muted}>Loading backups…</p>;
  if (error || !data) return <Banner tone="danger">Could not load backups. Only the owner can see this page.</Banner>;

  const draft = edits ?? data.settings;
  const setDraft = (next: BackupSettingsView) => setEdits(next);
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const lastNight = data.lastNightly;
  const lastManualFailed = data.lastRun && !data.lastRun.ok && data.lastRun.kind === 'manual' ? data.lastRun : null;

  const onDelete = async (b: BackupEntryView) => {
    const ok = await confirmDialog({
      title: 'Delete this backup?',
      message: <>The file <code>{b.name}</code> is removed from the backups folder. This cannot be undone.</>,
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (ok) remove.mutate(b.name);
  };

  const setNumber = (field: 'keepDaily' | 'keepWeekly', raw: string, min: number, max: number) => {
    const n = parseInt(raw, 10);
    setDraft({ ...draft, [field]: Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : min });
  };

  return (
    <div className={styles.page}>
      {lastNight && !lastNight.ok && (
        <Banner tone="danger">The last nightly backup, {when(lastNight.startedAt)}, failed: {lastNight.error}</Banner>
      )}
      {lastManualFailed && (
        <Banner tone="danger">The backup you started {when(lastManualFailed.startedAt)} failed: {lastManualFailed.error}</Banner>
      )}
      {!data.dedicated && (
        <Banner tone="warning">
          Backups are going into the app's cache folder (<code>{data.dir}</code>), which is not meant to be kept.
          Set <code>BACKUP_DIR</code> for the app to a folder of its own. The installer's compose file does this for you.
        </Banner>
      )}
      {data.error && <Banner tone="danger">{data.error}</Banner>}

      <section className={styles.section} aria-labelledby="backups-list">
        <div className={styles.head}>
          <h3 id="backups-list" className={styles.title}>Backups</h3>
          <Button onClick={() => backUp.mutate()} loading={data.running || backUp.isPending} disabled={data.running}>
            {data.running ? 'Backing up…' : 'Back up now'}
          </Button>
        </div>
        {backUp.error && <Banner tone="danger">Could not start the backup.</Banner>}
        {data.backups.length === 0 ? (
          <p className={styles.muted}>No backups yet. {data.settings.enabled ? `The first nightly backup runs at ${hourLabel(data.settings.hour)}.` : 'Nightly backups are off.'} You can also back up now.</p>
        ) : (
          <>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr><th>Taken</th><th>Kind</th><th className={styles.num}>Size</th><th>Checked</th><th><span className="visually-hidden">Actions</span></th></tr>
                </thead>
                <tbody>
                  {data.backups.map((b) => (
                    <tr key={b.name}>
                      <td><span title={b.name}>{when(b.createdAt)}</span></td>
                      <td><Badge tone={KIND[b.kind].tone}>{KIND[b.kind].label}</Badge></td>
                      <td className={styles.num}>{formatBytes(b.bytes)}</td>
                      <td>
                        {b.verified === true && <span className={styles.ok}>Readable</span>}
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
              {data.backups.length} backup{data.backups.length === 1 ? '' : 's'}, {formatBytes(data.totalBytes)} in all.
              "Readable" means the file was read back in full right after it was written.
            </p>
          </>
        )}
      </section>

      <section className={styles.section} aria-labelledby="backups-schedule">
        <h3 id="backups-schedule" className={styles.title}>Nightly backup</h3>
        <div className={styles.fields}>
          <div className={styles.field}>
            <span className={styles.label}>Nightly backup</span>
            <SegmentedControl label="Nightly backup" value={draft.enabled ? 'on' : 'off'} onChange={(v) => setDraft({ ...draft, enabled: v === 'on' })} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
          </div>
          <label className={styles.field}>
            <span className={styles.label}>Time ({data.timeZone})</span>
            <Select value={draft.hour} disabled={!draft.enabled} onChange={(e) => setDraft({ ...draft, hour: parseInt(e.target.value, 10) })}>
              {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </Select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Days to keep</span>
            <Input type="number" inputMode="numeric" min={1} max={90} value={draft.keepDaily} onChange={(e) => setNumber('keepDaily', e.target.value, 1, 90)} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Weeks to keep</span>
            <Input type="number" inputMode="numeric" min={0} max={52} value={draft.keepWeekly} onChange={(e) => setNumber('keepWeekly', e.target.value, 0, 52)} />
          </label>
        </div>
        <p className={styles.hint}>
          Keeps the newest nightly backup of each of the last {draft.keepDaily} day{draft.keepDaily === 1 ? '' : 's'}
          {draft.keepWeekly > 0 ? `, and the newest of each of the last ${draft.keepWeekly} week${draft.keepWeekly === 1 ? '' : 's'}` : ''}. Older nightly backups are deleted after each night's run.
          Manual backups and the ones taken before an update or a restore are kept until you delete them.
        </p>
        <div className={styles.row}>
          <Button onClick={() => save.mutate(draft, { onSuccess: () => setEdits(null) })} disabled={!dirty} loading={save.isPending}>Save</Button>
          {dirty && <Button variant="quiet" onClick={() => setEdits(null)}>Cancel</Button>}
          {save.error && <span className={styles.bad}>{(save.error as { detail?: string }).detail ?? 'Could not save.'}</span>}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="backups-where">
        <h3 id="backups-where" className={styles.title}>Where the files are</h3>
        <p className={styles.hint}>
          The app writes backups to <code>{data.dir}</code> inside its container. With the installer's compose file that is a Docker volume
          called <code>backups</code>, or a folder on this computer if you set <code>TAGAVE_BACKUP_DIR</code> in the install folder's <code>.env</code>.
          The settings above are saved in that folder too, as <code>backup-settings.json</code>.
        </p>
        <p className={styles.hint}>
          A backup on the same disk does not help if that disk fails. Copy the folder somewhere else from time to time: download a backup here,
          or copy the whole folder out of the container and then onto another computer, a NAS or cloud storage (rsync, rclone, or a file sync app):
        </p>
        <pre className={styles.code}>{COPY_CMD}</pre>
        <p className={styles.hint}>
          Keep the <code>APP_SECRET</code> from your <code>.env</code> in a password manager as well. A backup restored without it still has all your
          music data, but saved Discogs and AcoustID keys have to be entered again.
        </p>
        <h4 className={styles.subTitle}>Restoring a backup</h4>
        <p className={styles.hint}>
          Restoring replaces everything in the database. Stop the app and workers, restore, and start them again. The current database is kept
          under another name until you drop it, so you can go back.
        </p>
        <pre className={styles.code}>{RESTORE_CMD}</pre>
      </section>
    </div>
  );
}
