/**
 * Settings › Library › Drop pool (owner, 0081): a folder in a writable music
 * folder where dropped albums are identified, then imported by the naming
 * rules or left in Library care › Inbox. Off and On and the music folder
 * save when changed, the outcome in the group's head; the folder is typed
 * and saved with its Save. One row says what the file worker last found:
 * Ready · the folder, Can't reach the music folder, or Folder missing.
 */
import { useState, type FormEvent } from 'react';
import { DROP_POOL_DEFAULT_DIR, DROP_POOL_STATE_LABELS, type DropPoolView, type PutDropPool } from '@tagave/shared';
import { Input, SaveStatus, SegmentedControl, Select, SettingsGroup, SettingsRow, SettingsSave, useSaveFlash, type SaveState } from '../ui';
import { useCurrentLibrary } from '../../hooks';
import { useDropPool, useSaveDropPool } from '../../hooks/useNaming';
import styles from './Naming.module.css';

const errorText = (err: unknown): string | null => (err as { detail?: string } | null)?.detail ?? null;

/** Which part of the group the last save was: its outcome shows there. */
export type DropPoolChange = 'choice' | 'folder';

export function DropPoolSettings() {
  const { libraryId } = useCurrentLibrary();
  const pool = useDropPool(libraryId);
  if (!pool.data) return null;
  return <DropPoolForm key={libraryId} libraryId={libraryId} view={pool.data} />;
}

function DropPoolForm({ libraryId, view }: { libraryId: string | undefined; view: DropPoolView }) {
  const save = useSaveDropPool(libraryId);
  const flash = useSaveFlash();
  const [changed, setChanged] = useState<DropPoolChange>('choice');
  const onPut = (body: PutDropPool, done: () => void, part: DropPoolChange = 'choice') => {
    setChanged(part);
    flash.clear();
    save.mutate(body, {
      onSuccess: () => { done(); flash.saved(); },
      onError: (err) => flash.failed(errorText(err)),
    });
  };
  return <DropPoolSettingsView view={view} pending={save.isPending} onPut={onPut} state={flash.state} detail={flash.detail} changed={changed} />;
}

/** What the file worker last found, in one line: Ready · the path, or why not. */
export function dropPoolLine(view: Pick<DropPoolView, 'enabled' | 'state' | 'path'>): string | null {
  if (!view.enabled || !view.state) return null;
  return view.state === 'ready' && view.path ? `${DROP_POOL_STATE_LABELS.ready} · ${view.path}` : DROP_POOL_STATE_LABELS[view.state];
}

export interface DropPoolSettingsViewProps {
  view: DropPoolView;
  pending?: boolean;
  /** save; `done` clears the edits once saved; `part` is what changed */
  onPut: (body: PutDropPool, done: () => void, part?: DropPoolChange) => void;
  /** the last save's outcome */
  state?: SaveState;
  detail?: string | null;
  /** where the last save was (default the choices, in the head) */
  changed?: DropPoolChange;
}

/** The section without data fetching (Storybook renders it with fixtures). */
export function DropPoolSettingsView({ view, pending = false, onPut, state = null, detail = null, changed = 'choice' }: DropPoolSettingsViewProps) {
  const [dir, setDir] = useState<string | null>(null);
  const currentRoot = view.scanRootId ?? view.roots[0]?.id ?? '';
  const savedDir = view.dirPath ?? DROP_POOL_DEFAULT_DIR;
  const currentDir = dir ?? savedDir;
  const line = dropPoolLine(view);
  const body = (root: string, d: string): PutDropPool => ({ enabled: true, ...(root ? { scanRootId: root } : {}), ...(d.trim() ? { dirPath: d.trim() } : {}) });
  const dirty = !!currentDir.trim() && currentDir.trim() !== savedDir;

  const saveDir = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || pending) return;
    onPut(body(currentRoot, currentDir), () => setDir(null), 'folder');
  };

  const found = view.problem ?? line;
  const counts: Array<[string, number]> = [['Waiting', view.counts.waiting], ['Inbox', view.counts.inbox], ['Imported', view.counts.imported], ['Skipped', view.counts.skipped]];

  return (
    <form className={styles.section} onSubmit={saveDir} noValidate>
      <SettingsGroup
        title="Drop pool"
        help="Albums dropped in this folder are identified, then imported by the naming rules or left in Library care › Inbox"
        status={changed === 'choice' ? <SaveStatus state={state} detail={detail} /> : null}
        after={view.enabled ? <div className={styles.buttons}><SettingsSave type="submit" dirty={dirty} pending={pending && changed === 'folder'} onSave={() => undefined} state={changed === 'folder' ? state : null} detail={detail} /></div> : undefined}
      >
        <SettingsRow as="div" label="Drop pool">
          <SegmentedControl
            label="Drop pool"
            value={view.enabled ? 'on' : 'off'}
            onChange={(v) => onPut(v === 'on' ? body(currentRoot, savedDir) : { enabled: false }, () => setDir(null))}
            options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On', disabled: view.roots.length === 0 }]}
          />
        </SettingsRow>
        {view.enabled && view.roots.length > 1 && (
          <SettingsRow label="Music folder">
            <Select dense value={currentRoot} disabled={pending} onChange={(e) => onPut(body(e.currentTarget.value, savedDir), () => undefined)}>
              {view.roots.map((r) => <option key={r.id} value={r.id}>{r.path}</option>)}
            </Select>
          </SettingsRow>
        )}
        {view.enabled && (
          <SettingsRow label="Folder">
            <Input dense className={`${styles.field} ${styles.mono}`} value={currentDir} spellCheck={false} autoComplete="off" onChange={(e) => setDir(e.currentTarget.value)} />
          </SettingsRow>
        )}
        {found && (
          <SettingsRow as="div" label="Check" value={<span className={!view.problem && view.state === 'ready' ? styles.value : styles.error}>{found}</span>} />
        )}
        {view.path && !line && <SettingsRow as="div" label="Path" value={<span className={`${styles.value} ${styles.mono}`}>{view.path}</span>} />}
        {counts.map(([label, n]) => <SettingsRow key={label} as="div" label={label} value={<span className={styles.value}>{n.toLocaleString()}</span>} />)}
      </SettingsGroup>
    </form>
  );
}
