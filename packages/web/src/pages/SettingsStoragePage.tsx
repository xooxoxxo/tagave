/**
 * Settings › Status, after System status: how much room tagave takes on
 * this server, as groups (spec §6): Storage (the total), Database by kind
 * of data (bars show each group's share of the database), the Folders the
 * app owns, Free space on each disk, and Tag change cleanup (an action).
 * What a row is (a folder's path, a disk's folders) sits behind its `?`.
 * StorageView, DiskSpace and TagChangeCleanupView draw from props (stories,
 * tests); SettingsStorageContent connects them.
 */
import { useRef, useState, type ReactNode } from 'react';
import { PROBLEM_TYPES, type DiskSpaceView, type StorageOverview, type TagChangeCleanupPreview, type TagChangeCleanupScope } from '@tagave/shared';
import { Badge, Banner, Button, LinkButton, SegmentedControl, SettingsGroup, SettingsRow, confirmDialog, showToast } from '../components/ui';
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

/** A row's value: its bar, then its size. */
function Size({ share, children }: { share: number; children: ReactNode }) {
  return <span className={styles.size}><Bar share={share} /><span>{children}</span></span>;
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

export interface StorageViewProps {
  data: StorageOverview;
  refreshing?: boolean;
  onRefresh: () => void;
  /** Tag change cleanup's group, last */
  cleanup: ReactNode;
}

export function StorageView({ data, refreshing = false, onRefresh, cleanup }: StorageViewProps) {
  const db = data.database;
  const folderTotal = data.folders.reduce((n, f) => n + f.bytes, 0);
  const grand = db.totalBytes + folderTotal;
  return (
    <div className={styles.page}>
      <SettingsGroup title="Storage" meta={shortDate(data.checkedAt)}>
        <SettingsRow as="div" label="Total" value={<span className={styles.total}>{formatBytes(grand)}</span>}>
          <Button variant="secondary" size="sm" loading={refreshing} onClick={onRefresh}>Refresh</Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Database" meta={formatBytes(db.totalBytes)}>
        {db.categories.map((c) => (
          <SettingsRow
            key={c.key}
            as="div"
            label={c.label}
            help={<>{c.description}{c.tables.length > 0 && <span className={styles.tables}>{c.tables.map((t) => `${t.name} ${formatBytes(t.bytes)}`).join(' · ')}</span>}</>}
            value={<Size share={db.totalBytes > 0 ? c.bytes / db.totalBytes : 0}>{formatBytes(c.bytes)}</Size>}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup title="Folders" meta={formatBytes(folderTotal)}>
        {data.folders.map((f) => (
          <SettingsRow
            key={f.key}
            as="div"
            label={f.label}
            help={<><code className={styles.path}>{f.path}</code>{f.exists && <> · {f.files.toLocaleString()} {f.files === 1 ? 'file' : 'files'}{f.truncated ? ', counting stopped early' : ''}</>}</>}
            value={f.error
              ? <span className={styles.error}>{f.error}</span>
              : <Size share={grand > 0 ? f.bytes / grand : 0}>{f.exists ? `${formatBytes(f.bytes)}${f.truncated ? '+' : ''}` : 'Not there'}</Size>}
          >
            {f.key === 'backups' && <LinkButton to="/settings/$section" params={{ section: 'backups' }} variant="quiet" size="sm">Manage</LinkButton>}
          </SettingsRow>
        ))}
      </SettingsGroup>

      <DiskSpace disk={data.disk} />

      {cleanup}
    </div>
  );
}

export function SettingsStorageContent() {
  const { data, isLoading, error, refetch, isFetching } = useStorage();

  if (isLoading) return <p className={styles.muted}>Measuring…</p>;
  if (error || !data) return <Banner tone="danger">{storageErrorText(error)}</Banner>;
  return <StorageView data={data} refreshing={isFetching} onRefresh={() => void refetch()} cleanup={<TagChangeCleanup />} />;
}

const DISK_BADGE = { warn: { tone: 'warning', label: 'Filling up' }, fail: { tone: 'danger', label: 'Almost full' } } as const;

/**
 * Free space on each disk tagave writes (the doctor's disk check): the
 * fullest first, its folders behind its `?`. Bars show how full each disk is.
 */
export function DiskSpace({ disk }: { disk: DiskSpaceView | null | undefined }) {
  const notice = diskNoticeText(disk);
  return (
    <SettingsGroup
      title="Free space"
      meta={disk ? null : 'Could not be read'}
      after={notice && <Banner tone={notice.tone}>{notice.text} Never delete Docker volumes. <a href={docsUrl('operations.md#disk-space')} target="_blank" rel="noreferrer">How to</a></Banner>}
    >
      {disk && <>
        {disk.filesystems.map((f) => (
          <SettingsRow
            key={f.paths.map((p) => p.key).join('+')}
            as="div"
            label={pathsLabel(f.paths.map((p) => p.label))}
            help={f.paths.map((p, i) => <span key={p.key}>{i > 0 && ', '}<code className={styles.path}>{p.path}</code></span>)}
            value={<>
              {f.status !== 'pass' && <Badge tone={DISK_BADGE[f.status].tone}>{DISK_BADGE[f.status].label}</Badge>}
              <Size share={f.usedPct / 100}>{formatBytes(f.freeBytes)} free</Size>
            </>}
          />
        ))}
        {disk.unmeasured.map((u) => (
          <SettingsRow key={u.key} as="div" label={u.label} help={u.reason} value={<span className={styles.muted}>Not measured</span>} />
        ))}
      </>}
    </SettingsGroup>
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

export interface TagChangeCleanupViewProps {
  scope: TagChangeCleanupScope;
  onScope: (scope: TagChangeCleanupScope) => void;
  /** what the scope would delete; null while counting or when it could not count */
  preview: TagChangeCleanupPreview | null;
  counting?: boolean;
  pending?: boolean;
  onRun: () => void;
}

/** "3 plans · 1.2 MB · 2 plans revertible (300 KB) kept", or None. */
function cleanupValue(p: TagChangeCleanupPreview): string {
  if (p.plans === 0 && p.revertible.plans === 0) return 'None';
  return [
    `${plansText(p.plans)} · ${formatBytes(p.bytes)}`,
    p.revertible.plans > 0 ? `${plansText(p.revertible.plans)} revertible (${formatBytes(p.revertible.bytes)}) kept` : null,
  ].filter(Boolean).join(' · ');
}

/** Tag change cleanup: which finished plans, how many, and Delete (an action that asks first). */
export function TagChangeCleanupView({ scope, onScope, preview, counting = false, pending = false, onRun }: TagChangeCleanupViewProps) {
  const nothing = !!preview && preview.plans === 0 && preview.revertible.plans === 0;
  return (
    <SettingsGroup title="Tag change cleanup">
      <SettingsRow as="div" label="Which plans">
        <SegmentedControl
          label="Which plans"
          value={scope}
          onChange={onScope}
          options={[{ value: 'archived', label: 'Archived' }, { value: 'finished', label: 'All finished' }]}
        />
      </SettingsRow>
      <SettingsRow
        as="div"
        label="To delete"
        value={<span className={preview ? styles.size : styles.muted}>{counting ? 'Counting' : preview ? cleanupValue(preview) : 'Not counted'}</span>}
      >
        <Button variant="quiet-danger" size="sm" onClick={onRun} disabled={!preview || nothing || pending} loading={pending}>Delete</Button>
      </SettingsRow>
    </SettingsGroup>
  );
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

  return <TagChangeCleanupView scope={scope} onScope={setScope} preview={preview.error ? null : p ?? null} counting={preview.isLoading} pending={cleanup.isPending} onRun={() => void run()} />;
}
