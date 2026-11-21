/**
 * Settings › Library › Music folders (LIB-1): a group per music folder (its
 * name, its path in the head), then Add music folder, whose Tag writes
 * choice joins Add. A folder's Scanning and Tag writes are Off and On, saved
 * when changed (Tag writes asks first before it allows writes); the folder link is typed and saved with its Save; Scan,
 * Check and Remove are actions. MusicFoldersView is the section alone,
 * driven by props (stories); SettingsScanRootsContent connects it.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useCurrentLibrary, useScanRoots, useCreateScanRoot, useUpdateScanRoot, useDeleteScanRoot, useStartScan, useValidateScanRoot } from '../hooks';
import { SCAN_ROOT_EMPTY_MESSAGE, folderLinkBaseProblem, type ScanRoot } from '@tagave/shared';
import { Button, Input, SaveStatus, SegmentedControl, SettingsGroup, SettingsRow, SettingsSave, confirmDialog, sentence, useSaveFlash, useSettingsDraft } from '../components/ui';
import { shortDate } from '../utils/time';
import styles from './SettingsScanRootsPage.module.css';

const ON_OFF = [{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }];

/** 21600 → "6 h", 600 → "10 min", 90 → "90 s" */
export function rescanLabel(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** What the worker found at the folder, as a word, whether it is a problem, and the worker's own words for it. */
export function folderCheck(root: ScanRoot): { text: string; problem: boolean; help?: string | undefined } {
  const help = root.validationMessage || undefined;
  switch (root.validationStatus) {
    case 'pending': return { text: 'Pending', problem: false };
    case 'missing': return { text: 'Missing', problem: true, help };
    case 'not_directory': return { text: 'Not a directory', problem: true, help };
    case 'unreadable': return { text: 'Unreadable', problem: true, help };
    default: break;
  }
  if (root.validationMessage === SCAN_ROOT_EMPTY_MESSAGE) return { text: 'Empty', problem: true };
  if (root.lastStatus === 'aborted') return { text: 'Unreachable', problem: true };
  // the probe warning: writes are allowed but the worker sees a read-only mount
  if (root.probeWritable === false) return root.writable ? { text: 'Mount is read-only', problem: true } : { text: 'Read-only mount', problem: false };
  return { text: 'OK', problem: false };
}

/** The worker has checked the folder and may write there. */
const canEnableWrites = (root: ScanRoot) => root.validationStatus === 'ok' && root.probeWritable !== false;

export interface NewMusicFolder {
  path: string;
  displayName: string;
  pollIntervalS: number;
  /** tag plans may write under it */
  writable: boolean;
}

export interface MusicFoldersViewProps {
  roots: ScanRoot[];
  /** the folders are still loading */
  loading?: boolean;
  /** a folder whose action is on its way */
  pending?: (rootId: string) => boolean;
  /** a change to one folder; resolves to null once saved, else the API's detail ('' for none) */
  onUpdate: (root: ScanRoot, data: Partial<ScanRoot>) => Promise<string | null>;
  onScan: (root: ScanRoot) => void;
  onCheck: (root: ScanRoot) => void;
  onRemove: (root: ScanRoot) => void;
  adding?: boolean;
  addError?: string | null;
  /** resolves true once the folder is added (the form then empties) */
  onAdd: (folder: NewMusicFolder) => Promise<boolean> | boolean;
}

export function MusicFoldersView({ roots, loading = false, pending = () => false, onUpdate, onScan, onCheck, onRemove, adding = false, addError = null, onAdd }: MusicFoldersViewProps) {
  return (
    <div className={styles.page}>
      {loading ? null : roots.length === 0 ? (
        <SettingsGroup title="Music folders" meta="No music folders" />
      ) : (
        roots.map((root) => (
          <FolderGroup key={root.id} root={root} busy={pending(root.id)} onUpdate={onUpdate} onScan={onScan} onCheck={onCheck} onRemove={onRemove} />
        ))
      )}
      <AddMusicFolder adding={adding} error={addError} onAdd={onAdd} />
    </div>
  );
}

interface FolderGroupProps {
  root: ScanRoot;
  busy: boolean;
  onUpdate: MusicFoldersViewProps['onUpdate'];
  onScan: (root: ScanRoot) => void;
  onCheck: (root: ScanRoot) => void;
  onRemove: (root: ScanRoot) => void;
}

function FolderGroup({ root, busy, onUpdate, onScan, onCheck, onRemove }: FolderGroupProps) {
  const choice = useSaveFlash();
  const linkFlash = useSaveFlash();
  const base = useMemo(() => ({ folderLink: root.folderLink ?? '' }), [root.folderLink]);
  const { draft, set } = useSettingsDraft(base);
  const link = (draft ?? base).folderLink;
  const problem = folderLinkBaseProblem(link);
  const dirty = link.trim() !== base.folderLink.trim() && !problem;
  const [saving, setSaving] = useState(false);
  const check = folderCheck(root);
  const scanning = root.lastStatus === 'scanning';
  const writesLocked = !root.writable && !canEnableWrites(root);

  const change = async (data: Partial<ScanRoot>) => {
    choice.clear();
    const failed = await onUpdate(root, data);
    if (failed === null) choice.saved(); else choice.failed(failed || null);
  };
  const setWrites = async (on: boolean) => {
    if (on && !(await confirmDialog({ title: 'Allow tag writes under this folder?', message: <><p><code>{root.path}</code></p><p>Every write can be reverted.</p></>, confirmLabel: 'Allow writes' }))) return;
    await change({ writable: on });
  };
  const saveLink = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    linkFlash.clear();
    const failed = await onUpdate(root, { folderLink: link.trim() || null });
    setSaving(false);
    if (failed === null) linkFlash.saved(); else linkFlash.failed(failed || null);
  };

  const found = [
    `${(root.albumsFound ?? 0).toLocaleString()} ${root.albumsFound === 1 ? 'album' : 'albums'}`,
    `${(root.tracksFound ?? 0).toLocaleString()} ${root.tracksFound === 1 ? 'track' : 'tracks'}`,
    ...(root.lastScanAt ? [`Scanned ${shortDate(root.lastScanAt, { time: false })}`] : []),
  ].join(' · ');

  const actions = (
    <div className={styles.actions}>
      <SettingsSave type="submit" dirty={dirty} pending={saving} onSave={() => undefined} state={linkFlash.state} detail={linkFlash.detail} label={link.trim() || !base.folderLink ? 'Save link' : 'Remove link'} />
      <Button variant="secondary" size="sm" onClick={() => onScan(root)} loading={scanning} disabled={busy || root.validationStatus !== 'ok'}>Scan</Button>
      <Button variant="secondary" size="sm" onClick={() => onCheck(root)} disabled={busy}>Check</Button>
      <Button variant="quiet-danger" size="sm" onClick={() => onRemove(root)} disabled={busy}>Remove</Button>
    </div>
  );

  return (
    <form onSubmit={(e) => void saveLink(e)} noValidate>
      <SettingsGroup title={root.displayName} meta={<code className={styles.path}>{root.path}</code>} status={<SaveStatus state={choice.state} detail={choice.detail} />} after={actions}>
        <SettingsRow as="div" label="Scanning">
          <SegmentedControl label="Scanning" value={root.enabled ? 'on' : 'off'} onChange={(v) => void change({ enabled: v === 'on' })} options={ON_OFF} />
        </SettingsRow>
        <SettingsRow as="div" label="Tag writes" help={writesLocked ? 'On once the worker has checked the folder and sees a read-write mount. Every write can be reverted.' : 'Tag plans write files under this folder. Every write can be reverted.'}>
          <SegmentedControl
            label="Tag writes"
            value={root.writable ? 'on' : 'off'}
            onChange={(v) => void setWrites(v === 'on')}
            options={[ON_OFF[0]!, { ...ON_OFF[1]!, disabled: writesLocked }]}
          />
        </SettingsRow>
        <SettingsRow as="div" label="Rescan every" value={<span className={styles.value}>{rescanLabel(root.pollIntervalS)}</span>} />
        <SettingsRow as="div" label="Found" value={<span className={styles.value}>{found}</span>} />
        <SettingsRow as="div" label="Check" help={check.help} value={<span className={check.problem ? styles.problem : styles.value} role={check.problem ? 'alert' : undefined}>{check.text}</span>} />
        <SettingsRow
          label="Folder link"
          help="Where your own computer sees this folder. An album's Open folder link is this plus the album's folder."
          value={problem ? <span className={styles.problem}>{problem}</span> : undefined}
        >
          <Input
            dense
            className={styles.field}
            value={link}
            onChange={(e) => set({ folderLink: e.currentTarget.value })}
            placeholder="smb://nas/music/"
            aria-invalid={problem ? true : undefined}
            spellCheck={false}
            autoCapitalize="off"
          />
        </SettingsRow>
      </SettingsGroup>
    </form>
  );
}

const EMPTY_FOLDER: NewMusicFolder = { path: '', displayName: '', pollIntervalS: 21600, writable: true };

type FolderField = 'path' | 'displayName' | 'pollIntervalS';

/** Why a new folder cannot be added, per field. */
function folderProblems(f: NewMusicFolder): Partial<Record<FolderField, string>> {
  const out: Partial<Record<FolderField, string>> = {};
  if (!f.path.trim()) out.path = 'Path is required';
  else if (!f.path.trim().startsWith('/')) out.path = 'Path must start with /';
  if (!f.displayName.trim()) out.displayName = 'Name is required';
  if (!(f.pollIntervalS >= 60)) out.pollIntervalS = 'At least 60 seconds';
  return out;
}

function AddMusicFolder({ adding, error, onAdd }: { adding: boolean; error: string | null; onAdd: MusicFoldersViewProps['onAdd'] }) {
  const [folder, setFolder] = useState<NewMusicFolder>(EMPTY_FOLDER);
  const [problems, setProblems] = useState<Partial<Record<FolderField, string>>>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = folderProblems(folder);
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    if (await onAdd({ ...folder, path: folder.path.trim(), displayName: folder.displayName.trim() })) setFolder(EMPTY_FOLDER);
  };
  const problemOf = (key: FolderField) => (problems[key] ? <span className={styles.problem} role="alert">{problems[key]}</span> : undefined);
  const ready = !!folder.path.trim() && !!folder.displayName.trim();
  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <SettingsGroup
        title="Add music folder"
        after={(
          <div className={styles.actions}>
            <Button type="submit" size="sm" loading={adding} disabled={!ready}>Add</Button>
            {error && <span className={styles.problem} role="alert">{sentence(error)}</span>}
          </div>
        )}
      >
        <SettingsRow label="Path" value={problemOf('path')}>
          <Input dense className={styles.field} value={folder.path} placeholder="/music" spellCheck={false} autoCapitalize="off" disabled={adding} onChange={(e) => setFolder({ ...folder, path: e.currentTarget.value })} />
        </SettingsRow>
        <SettingsRow label="Name" value={problemOf('displayName')}>
          <Input dense className={styles.field} value={folder.displayName} placeholder="Music" disabled={adding} onChange={(e) => setFolder({ ...folder, displayName: e.currentTarget.value })} />
        </SettingsRow>
        <SettingsRow label="Rescan every (seconds)" value={problemOf('pollIntervalS')}>
          <Input dense className={styles.number} type="number" min={60} step={60} value={folder.pollIntervalS} disabled={adding} onChange={(e) => setFolder({ ...folder, pollIntervalS: Number(e.currentTarget.value) })} />
        </SettingsRow>
        <SettingsRow as="div" label="Tag writes" help="Tag plans write files under this folder. Every write can be reverted.">
          <SegmentedControl label="Tag writes" value={folder.writable ? 'on' : 'off'} onChange={(v) => setFolder({ ...folder, writable: v === 'on' })} options={ON_OFF.map((o) => ({ ...o, disabled: adding }))} />
        </SettingsRow>
      </SettingsGroup>
    </form>
  );
}

const detailOf = (err: unknown): string => (err as { detail?: string } | null)?.detail ?? '';

/** Settings › Library's Music folders, connected. */
export function SettingsScanRootsContent() {
  const { libraryId } = useCurrentLibrary();
  const { data: roots = [], isLoading } = useScanRoots(libraryId);
  const create = useCreateScanRoot(libraryId);
  const update = useUpdateScanRoot(libraryId);
  const remove = useDeleteScanRoot(libraryId);
  const scan = useStartScan(libraryId);
  const validate = useValidateScanRoot(libraryId);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  if (!libraryId) return null;

  const run = (rootId: string, go: (done: () => void) => void) => {
    setBusy((prev) => new Set(prev).add(rootId));
    go(() => setBusy((prev) => { const next = new Set(prev); next.delete(rootId); return next; }));
  };

  return (
    <MusicFoldersView
      roots={roots}
      loading={isLoading}
      pending={(id) => busy.has(id)}
      onUpdate={(root, data) => new Promise((resolve) => run(root.id, (done) => update.mutate({ rootId: root.id, data }, {
        onSuccess: () => resolve(null),
        onError: (err) => resolve(detailOf(err)),
        onSettled: done,
      })))}
      onScan={(root) => run(root.id, (done) => scan.mutate(root.id, { onSettled: done }))}
      onCheck={(root) => run(root.id, (done) => validate.mutate(root.id, { onSettled: done }))}
      onRemove={(root) => void (async () => {
        if (!(await confirmDialog({ title: 'Remove this folder?', message: 'Your files stay on disk.', confirmLabel: 'Remove', tone: 'danger' }))) return;
        run(root.id, (done) => remove.mutate(root.id, { onSettled: done }));
      })()}
      adding={create.isPending}
      addError={create.error ? detailOf(create.error) || 'Not added' : null}
      onAdd={(f) => new Promise((resolve) => create.mutate({ ...f, enabled: true }, { onSuccess: () => resolve(true), onError: () => resolve(false) }))}
    />
  );
}
