/**
 * Settings › Storage: how much room tagave takes on this server. The
 * database by kind of data (bars show each group's share of the database),
 * the folders the app owns, and the cleanup of finished tag changes.
 */
import { useRef, useState } from 'react';
import { PROBLEM_TYPES, type DiskSpaceView, type TagChangeCleanupPreview, type TagChangeCleanupScope } from '@tagave/shared';
import { Badge, Banner, Button, SegmentedControl, confirmDialog, showToast } from '../components/ui';
import { diskNoticeText, pathsLabel } from '../components/DiskSpaceNotice';
import { useStorage, useTagChangeCleanup, useTagChangeCleanupPreview } from '../hooks/useStorage';
import { formatBytes } from '../utils/format';
import { docsUrl } from '../utils/docs';
import { shortDate } from '../utils/time';
import styles from './SettingsStoragePage.module.css';

const plansText = (n: number) => (n === 1 ? '1 plan' : `${n.toLocaleString()} plans`);

function Bar({ share }: { share: number }) {
  // a sliver stays visible for anything above zero
  const pct = share <= 0 ? 0 : Math.max(0.6, Math.min(100, share * 100));
  return <span className={styles.track} aria-hidden="true"><span className={styles.fill} style={{ width: `${pct}%` }} /></span>;
}

/**
 * What went wrong, from GET /storage's answer: the database, a measuring
 * step, who is asking, or the server itself. Only a 403 is about the owner.
 */
export function storageErrorText(error: unknown): string {
  const e = (error ?? {}) as { status?: unknown; type?: unknown; detail?: unknown };
  const status = typeof e.status === 'number' ? e.status : null;
  const detail = typeof e.detail === 'string' && e.detail.trim() ? ` ${e.detail.trim()}` : '';
  if (status === 403) return 'Only the owner can see this page.';
  if (status === 401) return 'You are signed out. Sign in again to see this page.';
  if (e.type === PROBLEM_TYPES.databaseUnreachable) return `Could not measure storage: the database is not answering.${detail}`;
  if (e.type === PROBLEM_TYPES.storageMeasurementFailed) return `Could not measure storage.${detail}`;
  if (status === null) return 'Could not measure storage: the server did not answer. Check your connection, or whether tagave is running.';
  if (status === 502 || status === 503 || status === 504) return `Could not measure storage: the server is not answering (${status}). It may be restarting; try again in a minute.`;
  return `Could not measure storage: the server answered ${status}.${detail}`;
}

export function SettingsStorageContent() {
  const { data, isLoading, error, refetch, isFetching } = useStorage();

  if (isLoading) return <p className={styles.muted}>Measuring…</p>;
  if (error || !data) return <Banner tone="danger">{storageErrorText(error)}</Banner>;

  const db = data.database;
  const folderTotal = data.folders.reduce((n, f) => n + f.bytes, 0);
  const grand = db.totalBytes + folderTotal;
  const checked = shortDate(data.checkedAt);

  return (
    <div className={styles.page}>
      <div className={styles.summary}>
        <p className={styles.total}><span className={styles.totalValue}>{formatBytes(grand)}</span></p>
        <div className={styles.refresh}>
          <span className={styles.muted}>{checked}</span>
          <Button variant="secondary" size="sm" loading={isFetching} onClick={() => void refetch()}>Refresh</Button>
        </div>
      </div>

      <DiskSpace disk={data.disk} />

      <section className={styles.section} aria-labelledby="storage-db">
        <div className={styles.head}>
          <h3 id="storage-db" className={styles.title}>Database</h3>
          <span className={styles.size}>{formatBytes(db.totalBytes)}</span>
        </div>
        <ul className={styles.rows}>
          {db.categories.map((c) => (
            <li key={c.key} className={styles.row}>
              <div className={styles.rowHead}>
                <span className={styles.label} title={[c.description, ...c.tables.map((t) => `${t.name}: ${formatBytes(t.bytes)}`)].join('\n')}>{c.label}</span>
                <span className={styles.size}>{formatBytes(c.bytes)}</span>
              </div>
              <Bar share={db.totalBytes > 0 ? c.bytes / db.totalBytes : 0} />
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="storage-folders">
        <div className={styles.head}>
          <h3 id="storage-folders" className={styles.title}>Folders</h3>
          <span className={styles.size}>{formatBytes(folderTotal)}</span>
        </div>
        <ul className={styles.rows}>
          {data.folders.map((f) => (
            <li key={f.key} className={styles.row}>
              <div className={styles.rowHead}>
                <span className={styles.label}>{f.label}</span>
                <span className={styles.size}>{f.exists ? `${formatBytes(f.bytes)}${f.truncated ? '+' : ''}` : 'Not there'}</span>
              </div>
              <Bar share={grand > 0 ? f.bytes / grand : 0} />
              <p className={styles.description}>
                <code className={styles.path}>{f.path}</code>
                {f.exists && <> · {f.files.toLocaleString()} {f.files === 1 ? 'file' : 'files'}{f.truncated ? ', counting stopped early' : ''}</>}
              </p>
              {f.error && <p className={styles.error}>{f.error}</p>}
            </li>
          ))}
        </ul>

      </section>

      <TagChangeCleanup />
    </div>
  );
}

const DISK_BADGE = { warn: { tone: 'warning', label: 'Filling up' }, fail: { tone: 'danger', label: 'Almost full' } } as const;

/**
 * Free space on each disk tagave writes (the doctor's disk check): the
 * fullest first, with the folders on it. Bars show how full each disk is.
 */
export function DiskSpace({ disk }: { disk: DiskSpaceView | null | undefined }) {
  const notice = diskNoticeText(disk);
  return (
    <section className={styles.section} aria-labelledby="storage-disk">
      <div className={styles.head}>
        <h3 id="storage-disk" className={styles.title}>Free space</h3>
      </div>
      {!disk ? <p className={styles.muted}>Free space could not be read</p> : <>
        {notice && <Banner tone={notice.tone}>{notice.text} Never delete Docker volumes. <a href={docsUrl('operations.md#disk-space')} target="_blank" rel="noreferrer">How to</a></Banner>}
        <ul className={styles.rows}>
          {disk.filesystems.map((f) => (
            <li key={f.paths.map((p) => p.key).join('+')} className={styles.row}>
              <div className={styles.rowHead}>
                <span className={styles.label}>
                  {pathsLabel(f.paths.map((p) => p.label))}
                  {f.status !== 'pass' && <> <Badge tone={DISK_BADGE[f.status].tone}>{DISK_BADGE[f.status].label}</Badge></>}
                </span>
                <span className={styles.size}>{formatBytes(f.freeBytes)} free</span>
              </div>
              <Bar share={f.usedPct / 100} />
              <p className={styles.description}>
                {f.paths.map((p, i) => <span key={p.key}>{i > 0 && ', '}<code className={styles.path}>{p.path}</code></span>)}
              </p>
            </li>
          ))}
        </ul>
        {disk.unmeasured.map((u) => <p key={u.key} className={styles.muted} title={u.reason}>{u.label}: not measured</p>)}

      </>}
    </section>
  );
}

/**
 * The choice inside the confirm: plans that can still be reverted are kept
 * unless the owner picks "Delete them too" here.
 */
function CleanupChoice({ preview, onChange }: { preview: TagChangeCleanupPreview; onChange: (includeRevertible: boolean) => void }) {
  const [include, setInclude] = useState(false);
  const plans = preview.plans + (include ? preview.revertible.plans : 0);
  const bytes = preview.bytes + (include ? preview.revertible.bytes : 0);
  return <>
    <p>This cannot be undone.</p>
    {preview.revertible.plans > 0 && <>
      <p><strong>{plansText(preview.revertible.plans)}</strong> can still be reverted. Deleting {preview.revertible.plans === 1 ? 'it' : 'them'} makes those changes permanent.</p>
      <div className={styles.choice}>
        <SegmentedControl
          label="Plans that can still be reverted"
          value={include ? 'delete' : 'keep'}
          onChange={(v) => { const next = v === 'delete'; setInclude(next); onChange(next); }}
          options={[{ value: 'keep', label: 'Keep them' }, { value: 'delete', label: 'Delete them too' }]}
        />
      </div>
    </>}
    <p className={styles.confirmTotal} role="status">{plans === 0 ? 'Nothing to delete' : <>Deletes <strong>{plansText(plans)}</strong>, about <strong>{formatBytes(bytes)}</strong></>}</p>
  </>;
}

function TagChangeCleanup() {
  const [scope, setScope] = useState<TagChangeCleanupScope>('archived');
  const preview = useTagChangeCleanupPreview(scope);
  const cleanup = useTagChangeCleanup();
  const include = useRef(false);
  const p = preview.data;

  const run = async () => {
    if (!p) return;
    include.current = false;
    const ok = await confirmDialog({
      title: scope === 'archived' ? 'Delete archived tag changes?' : 'Delete finished tag changes?',
      message: <CleanupChoice preview={p} onChange={(v) => { include.current = v; }} />,
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      const result = await cleanup.mutateAsync({ scope, includeRevertible: include.current });
      showToast({ message: result.deletedPlans === 0 ? 'Nothing was deleted.' : `Deleted ${plansText(result.deletedPlans)}, about ${formatBytes(result.freedBytes)}.` });
    } catch {
      showToast({ message: 'Could not clean up tag changes.', tone: 'danger' });
    }
  };

  const nothing = !!p && p.plans === 0 && p.revertible.plans === 0;
  return (
    <section className={styles.section} aria-labelledby="storage-cleanup">
      <h3 id="storage-cleanup" className={styles.title}>Clean up tag changes</h3>

      <SegmentedControl
        label="Which plans"
        value={scope}
        onChange={setScope}
        options={[{ value: 'archived', label: 'Archived plans' }, { value: 'finished', label: 'All finished plans' }]}
      />
      {preview.isLoading ? <p className={styles.muted}>Counting…</p>
        : preview.error || !p ? <Banner tone="danger">Could not count the tag changes.</Banner>
        : nothing ? <p className={styles.muted}>{scope === 'archived' ? 'No archived plans.' : 'No finished plans.'}</p>
        : <p className={styles.hint}>
            <strong>{plansText(p.plans)}</strong> · {formatBytes(p.bytes)}
            {p.revertible.plans > 0 && <> · {plansText(p.revertible.plans)} revertible ({formatBytes(p.revertible.bytes)}) kept</>}
          </p>}
      <div>
        <Button variant="quiet-danger" onClick={() => void run()} disabled={!p || nothing || cleanup.isPending} loading={cleanup.isPending}>Clean up…</Button>
      </div>
    </section>
  );
}
