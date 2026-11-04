/**
 * Settings › Library › Drop pool (owner, 0081): a folder in a writable music
 * folder where dropped albums are identified, then imported by the naming
 * rules or left in Library care › Inbox. Every change is saved at once.
 */
import { useId, useState } from 'react';
import { DROP_POOL_DEFAULT_DIR, type DropPoolView, type PutDropPool } from '@tagave/shared';
import { SegmentedControl, Select, TextField, showToast } from '../ui';
import { useCurrentLibrary } from '../../hooks';
import { useDropPool, useSaveDropPool } from '../../hooks/useNaming';
import styles from './Naming.module.css';

const errorText = (err: unknown, fallback: string) => (err as { detail?: string } | null)?.detail ?? fallback;

export function DropPoolSettings() {
  const { libraryId } = useCurrentLibrary();
  const pool = useDropPool(libraryId);
  if (!pool.data) return null;
  return <DropPoolForm key={libraryId} libraryId={libraryId} view={pool.data} />;
}

function DropPoolForm({ libraryId, view }: { libraryId: string | undefined; view: DropPoolView }) {
  const save = useSaveDropPool(libraryId);
  const headingId = useId();
  const [rootId, setRootId] = useState<string | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const currentRoot = rootId ?? view.scanRootId ?? view.roots[0]?.id ?? '';
  const currentDir = dir ?? view.dirPath ?? DROP_POOL_DEFAULT_DIR;

  const put = (body: PutDropPool) => save.mutate(body, {
    onSuccess: () => { setRootId(null); setDir(null); },
    onError: (err) => showToast({ message: errorText(err, 'Not saved'), tone: 'danger' }),
  });
  const onBody = (enabled: boolean, root = currentRoot, d = currentDir): PutDropPool => (enabled
    ? { enabled, ...(root ? { scanRootId: root } : {}), ...(d.trim() ? { dirPath: d.trim() } : {}) }
    : { enabled });

  const commitDir = () => {
    if (dir === null || dir.trim() === (view.dirPath ?? '')) return;
    if (view.enabled && dir.trim()) put(onBody(true, currentRoot, dir));
  };

  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>Drop pool</h2>
      <SegmentedControl
        label="Drop pool"
        value={view.enabled ? 'on' : 'off'}
        onChange={(v) => put(onBody(v === 'on'))}
        options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On', disabled: view.roots.length === 0 }]}
      />
      {view.roots.length > 1 && (
        <label className={styles.field}>
          <span className={styles.label}>Music folder</span>
          <Select
            value={currentRoot}
            disabled={save.isPending}
            onChange={(e) => {
              setRootId(e.target.value);
              if (view.enabled) put(onBody(true, e.target.value));
            }}
          >
            {view.roots.map((r) => <option key={r.id} value={r.id}>{r.path}</option>)}
          </Select>
        </label>
      )}
      <TextField
        label="Folder"
        value={currentDir}
        spellCheck={false}
        autoComplete="off"
        className={styles.mono}
        onChange={(e) => setDir(e.target.value)}
        onBlur={commitDir}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitDir(); } }}
      />
      {view.problem && <p className={styles.error} role="alert">{view.problem}</p>}
      <dl className={styles.values}>
        {view.path && <><dt>Path</dt><dd className={styles.mono}>{view.path}</dd></>}
        <dt>Waiting</dt><dd>{view.counts.waiting.toLocaleString()}</dd>
        <dt>Inbox</dt><dd>{view.counts.inbox.toLocaleString()}</dd>
        <dt>Imported</dt><dd>{view.counts.imported.toLocaleString()}</dd>
        <dt>Skipped</dt><dd>{view.counts.skipped.toLocaleString()}</dd>
      </dl>
    </section>
  );
}
