/**
 * Settings › Storage: how much room tagave takes on this server. The
 * database by kind of data (bars show each group's share of the database),
 * the folders the app owns, and the cleanup of finished tag changes.
 */
import { useRef, useState } from 'react';
import type { TagChangeCleanupPreview, TagChangeCleanupScope } from '@liner/shared';
import { Banner, Button, SegmentedControl, confirmDialog, showToast } from '../components/ui';
import { useStorage, useTagChangeCleanup, useTagChangeCleanupPreview } from '../hooks/useStorage';
import { formatBytes } from '../utils/format';
import styles from './SettingsStoragePage.module.css';

const plansText = (n: number) => (n === 1 ? '1 plan' : `${n.toLocaleString()} plans`);

function Bar({ share }: { share: number }) {
  // a sliver stays visible for anything above zero
  const pct = share <= 0 ? 0 : Math.max(0.6, Math.min(100, share * 100));
  return <span className={styles.track} aria-hidden="true"><span className={styles.fill} style={{ width: `${pct}%` }} /></span>;
}

export function SettingsStorageContent() {
  const { data, isLoading, error, refetch, isFetching } = useStorage();

  if (isLoading) return <p className={styles.muted}>Measuring…</p>;
  if (error || !data) return <Banner tone="danger">Could not measure storage. Only the owner can see this page.</Banner>;

  const db = data.database;
  const folderTotal = data.folders.reduce((n, f) => n + f.bytes, 0);
  const grand = db.totalBytes + folderTotal;
  const checked = new Date(data.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className={styles.page}>
      <div className={styles.summary}>
        <p className={styles.total}><span className={styles.totalValue}>{formatBytes(grand)}</span> in all</p>
        <div className={styles.refresh}>
          <span className={styles.muted}>Measured {checked}</span>
          <Button variant="secondary" size="sm" loading={isFetching} onClick={() => void refetch()}>Refresh</Button>
        </div>
      </div>

      <section className={styles.section} aria-labelledby="storage-db">
        <div className={styles.head}>
          <h3 id="storage-db" className={styles.title}>Database</h3>
          <span className={styles.size}>{formatBytes(db.totalBytes)}</span>
        </div>
        <ul className={styles.rows}>
          {db.categories.map((c) => (
            <li key={c.key} className={styles.row}>
              <div className={styles.rowHead}>
                <span className={styles.label}>{c.label}</span>
                <span className={styles.size}>{formatBytes(c.bytes)}</span>
              </div>
              <Bar share={db.totalBytes > 0 ? c.bytes / db.totalBytes : 0} />
              <p className={styles.description} title={c.tables.map((t) => `${t.name}: ${formatBytes(t.bytes)}`).join('\n') || undefined}>{c.description}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="storage-folders">
        <div className={styles.head}>
          <h3 id="storage-folders" className={styles.title}>Folders on this server</h3>
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
        <p className={styles.muted}>Bars show each folder's share of everything above, database included.</p>
      </section>

      <TagChangeCleanup />
    </div>
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
    <p>Deletes the plans with their previews and file lists. They cannot be brought back.</p>
    {preview.revertible.plans > 0 && <>
      <p><strong>{plansText(preview.revertible.plans)}</strong> can still be reverted: {preview.revertible.plans === 1 ? 'it holds' : 'they hold'} the old tags Revert puts back. Deleting {preview.revertible.plans === 1 ? 'it' : 'them'} makes those tag changes permanent.</p>
      <div className={styles.choice}>
        <SegmentedControl
          label="Plans that can still be reverted"
          value={include ? 'delete' : 'keep'}
          onChange={(v) => { const next = v === 'delete'; setInclude(next); onChange(next); }}
          options={[{ value: 'keep', label: 'Keep them' }, { value: 'delete', label: 'Delete them too' }]}
        />
      </div>
    </>}
    <p className={styles.confirmTotal} role="status">{plans === 0 ? 'Nothing would be deleted.' : <>Deletes <strong>{plansText(plans)}</strong>, about <strong>{formatBytes(bytes)}</strong>.</>}</p>
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
      <p className={styles.hint}>Finished plans (applied, failed, cancelled or reverted) keep their previews and, until reverted, the old tags of every file they wrote. Deleting them frees that room in the database, which Postgres reuses for new data.</p>
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
            <strong>{plansText(p.plans)}</strong>, about <strong>{formatBytes(p.bytes)}</strong>, can go.
            {p.revertible.plans > 0 && <> {plansText(p.revertible.plans)} more ({formatBytes(p.revertible.bytes)}) can still be reverted and {p.revertible.plans === 1 ? 'is' : 'are'} kept unless you choose otherwise.</>}
          </p>}
      <div>
        <Button variant="quiet-danger" onClick={() => void run()} disabled={!p || nothing || cleanup.isPending} loading={cleanup.isPending}>Clean up…</Button>
      </div>
    </section>
  );
}
