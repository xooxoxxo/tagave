/**
 * Settings › Modules › Lidarr (owner; the lidarr module), under the page's
 * heading and Off | On (SettingsModulesPage): the address and API key,
 * Test, then the root folder and the two profiles from what Test found,
 * Save and Disconnect. The key is sent, never shown: the field says only
 * whether one is saved. Saving and disconnecting ask for a fresh
 * confirmation (useStepUpAction).
 *
 * While the drop pool is on, Use the drop pool (on by default) makes the
 * pool's folder Lidarr's root folder: tagave adds it to Lidarr itself. "Lidarr
 * sees the music folder as" is the path mapping, for a Lidarr that sees the
 * music share at another path. One line says whether Lidarr can write in its
 * root folder, or where its container needs the share.
 * A root folder outside every music folder, or an import that landed
 * outside them, shows the warning with the music folders.
 */
import { useState, type FormEvent } from 'react';
import { lidarrReachLine, type LidarrRootCheckView, type LidarrSettingsView, type LidarrTestResult } from '@tagave/shared';
import { Banner, Button, SegmentedControl, Select, TextField, confirmDialog } from './ui';
import { useDisconnectLidarr, useLidarrRootCheck, useLidarrSettings, useSaveLidarr, useTestLidarr } from '../hooks/useLidarr';
import { useStepUpAction } from './users/useStepUpAction';
import styles from './LidarrSettings.module.css';

export interface LidarrDraft {
  url: string;
  apiKey: string;
  rootFolderPath: string;
  qualityProfileId: number | null;
  metadataProfileId: number | null;
  /** the drop pool is the root folder (only while the pool is on) */
  useDropPool: boolean;
  /** "Lidarr sees the music folder as"; empty: Lidarr sees it at tagave's path */
  lidarrPath: string;
  /** the music folder the mapping is for */
  mapRootId: string;
}

export function draftOf(view: LidarrSettingsView): LidarrDraft {
  const c = view.connection;
  return {
    url: c?.url ?? '',
    apiKey: '',
    rootFolderPath: c?.rootFolderPath ?? '',
    qualityProfileId: c?.qualityProfileId ?? null,
    metadataProfileId: c?.metadataProfileId ?? null,
    useDropPool: c ? c.useDropPool : !!view.pool,
    lidarrPath: c?.pathMap?.lidarrPath ?? '',
    mapRootId: c?.pathMap?.scanRootId ?? view.pool?.scanRootId ?? view.musicFolders[0]?.id ?? '',
  };
}

const join = (base: string, rel: string) => (rel ? `${base.replace(/\/+$/, '')}/${rel}` : base);

/** The pool's folder as Lidarr will see it with the draft's mapping (the server's lidarrPathOf). */
export function poolPathFor(view: LidarrSettingsView, draft: LidarrDraft): string | null {
  const pool = view.pool;
  if (!pool) return null;
  const root = view.musicFolders.find((r) => r.id === pool.scanRootId);
  if (!root) return pool.lidarrPath;
  const mapped = draft.lidarrPath.trim() && draft.mapRootId === pool.scanRootId ? draft.lidarrPath.trim() : null;
  return join(mapped ?? root.hostPath ?? root.path, pool.dirPath);
}

/** The draft differs from what is saved in what the root folder line is about. */
const sameRoot = (view: LidarrSettingsView, d: LidarrDraft) => {
  const saved = draftOf(view);
  return d.url === saved.url && d.useDropPool === saved.useDropPool && d.rootFolderPath === saved.rootFolderPath
    && d.lidarrPath.trim() === saved.lidarrPath && (!d.lidarrPath.trim() || d.mapRootId === saved.mapRootId);
};

export interface LidarrSettingsFormProps {
  view: LidarrSettingsView;
  draft: LidarrDraft;
  tested: LidarrTestResult | null;
  error: string | null;
  testing?: boolean;
  saving?: boolean;
  onChange: (d: LidarrDraft) => void;
  onTest: () => void;
  onSave: () => void;
  onDisconnect: () => void;
  /** what Lidarr can do in the saved root folder */
  rootCheck?: LidarrRootCheckView | null;
}

/** The form without data fetching (Storybook renders it with fixtures). */
export function LidarrSettingsForm({ view, draft, tested, error, testing = false, saving = false, onChange, onTest, onSave, onDisconnect, rootCheck = null }: LidarrSettingsFormProps) {
  const set = <K extends keyof LidarrDraft>(k: K, v: LidarrDraft[K]) => onChange({ ...draft, [k]: v });
  const c = view.connection;
  const usePool = !!view.pool && draft.useDropPool;
  // the selects: what Test found, else what is saved
  const folders = tested?.rootFolders ?? (c ? [c.rootFolderPath] : []);
  const quality = tested?.qualityProfiles ?? (c ? [{ id: c.qualityProfileId, name: c.qualityProfileName ?? `#${c.qualityProfileId}` }] : []);
  const metadata = tested?.metadataProfiles ?? (c ? [{ id: c.metadataProfileId, name: c.metadataProfileName ?? `#${c.metadataProfileId}` }] : []);
  const choices = !!tested || !!c;
  const ready = draft.url.trim() && (draft.apiKey || c?.keySaved) && (usePool || draft.rootFolderPath) && draft.qualityProfileId !== null && draft.metadataProfileId !== null;
  const version = tested?.version ?? c?.version ?? null;
  const mapRoot = view.musicFolders.find((r) => r.id === draft.mapRootId) ?? view.musicFolders[0] ?? null;
  const poolPath = poolPathFor(view, draft);
  const reach = c && rootCheck?.reach && sameRoot(view, draft) ? rootCheck : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) onSave();
  };
  return (
    <section className={styles.section} aria-label="Lidarr connection">
      {c?.keyUnreadable && <Banner tone="warning">Enter the API key again.</Banner>}
      {view.rootFolderOutside && view.scanRoots.length > 0 && !usePool && (
        <Banner tone="warning">
          <span className={styles.warnTitle}>Root folder isn’t in a scan root</span>
          <span className={styles.roots}>{view.scanRoots.map((r) => <code key={r}>{r}</code>)}</span>
        </Banner>
      )}
      <form className={styles.form} onSubmit={submit}>
        <TextField label="URL" required type="url" value={draft.url} placeholder="http://lidarr:8686" autoComplete="off" spellCheck={false} onChange={(e) => set('url', e.target.value)} />
        <TextField
          label="API key"
          type="password"
          value={draft.apiKey}
          placeholder={c?.keySaved ? 'Saved' : 'Not set'}
          autoComplete="new-password"
          spellCheck={false}
          onChange={(e) => set('apiKey', e.target.value.trim())}
        />
        {choices && <>
          {view.pool && (
            <div className={styles.field}>
              <span className={styles.label}>Use the drop pool</span>
              <SegmentedControl
                label="Use the drop pool"
                value={draft.useDropPool ? 'on' : 'off'}
                onChange={(v) => set('useDropPool', v === 'on')}
                options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
              />
            </div>
          )}
          {!usePool && (
            <label className={styles.field}>
              <span className={styles.label}>Root folder</span>
              <Select value={draft.rootFolderPath} onChange={(e) => set('rootFolderPath', e.target.value)}>
                {!draft.rootFolderPath && <option value="">Choose</option>}
                {folders.map((f) => <option key={f} value={f}>{f}</option>)}
              </Select>
            </label>
          )}
          <label className={styles.field}>
            <span className={styles.label}>Quality profile</span>
            <Select value={draft.qualityProfileId ?? ''} onChange={(e) => set('qualityProfileId', Number(e.target.value))}>
              {draft.qualityProfileId === null && <option value="">Choose</option>}
              {quality.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Metadata profile</span>
            <Select value={draft.metadataProfileId ?? ''} onChange={(e) => set('metadataProfileId', Number(e.target.value))}>
              {draft.metadataProfileId === null && <option value="">Choose</option>}
              {metadata.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
          {view.musicFolders.length > 1 && (
            <label className={styles.field}>
              <span className={styles.label}>Music folder</span>
              <Select value={draft.mapRootId} onChange={(e) => set('mapRootId', e.target.value)}>
                {view.musicFolders.map((r) => <option key={r.id} value={r.id}>{r.path}</option>)}
              </Select>
            </label>
          )}
          {mapRoot && (
            <TextField
              label="Lidarr sees the music folder as"
              value={draft.lidarrPath}
              placeholder={mapRoot.hostPath ?? mapRoot.path}
              autoComplete="off"
              spellCheck={false}
              className={styles.mono}
              onChange={(e) => onChange({ ...draft, lidarrPath: e.target.value, mapRootId: mapRoot.id })}
            />
          )}
        </>}
        {usePool && poolPath && (
          <dl className={styles.values}>
            <dt>Root folder</dt><dd>{poolPath}</dd>
          </dl>
        )}
        {reach?.reach && (
          <p className={reach.reach === 'writable' ? styles.status : styles.problem} role="status">{lidarrReachLine(reach.reach, reach.mountPath)}</p>
        )}
        {error
          ? <Banner tone="danger">{error}</Banner>
          : version && <p className={styles.status} role="status">Connected · {version}</p>}
        <div className={styles.buttons}>
          <Button type="button" variant="secondary" onClick={onTest} loading={testing} disabled={!draft.url.trim() || saving}>Test</Button>
          <Button type="submit" loading={saving} disabled={!ready || testing}>Save</Button>
          {c && <Button type="button" variant="quiet-danger" onClick={onDisconnect} disabled={saving || testing}>Disconnect</Button>}
        </div>
      </form>
    </section>
  );
}

const errorText = (err: unknown, fallback: string) => {
  const e = err as { detail?: string; title?: string } | null;
  return e?.detail ?? e?.title ?? fallback;
};

export function LidarrSettings() {
  const settings = useLidarrSettings();
  const test = useTestLidarr();
  const save = useSaveLidarr();
  const disconnect = useDisconnectLidarr();
  const { run, dialog } = useStepUpAction();
  const [draft, setDraft] = useState<LidarrDraft | null>(null);
  const [tested, setTested] = useState<LidarrTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootCheck = useLidarrRootCheck(!!settings.data?.connection && !settings.data.connection.keyUnreadable);

  if (!settings.data) return null;
  const view = settings.data;
  const current = draft ?? draftOf(view);

  const onTest = async () => {
    setError(null);
    try {
      const found = await test.mutateAsync({ url: current.url.trim(), ...(current.apiKey ? { apiKey: current.apiKey } : {}) });
      setTested(found);
      // the first of each, when nothing is chosen yet or the choice is gone
      setDraft({
        ...current,
        rootFolderPath: found.rootFolders.includes(current.rootFolderPath) ? current.rootFolderPath : found.rootFolders[0] ?? '',
        qualityProfileId: found.qualityProfiles.some((p) => p.id === current.qualityProfileId) ? current.qualityProfileId : found.qualityProfiles[0]?.id ?? null,
        metadataProfileId: found.metadataProfiles.some((p) => p.id === current.metadataProfileId) ? current.metadataProfileId : found.metadataProfiles[0]?.id ?? null,
      });
    } catch (err) {
      setTested(null);
      setError(errorText(err, 'Lidarr did not answer'));
    }
  };

  const onSave = async () => {
    setError(null);
    try {
      const usePool = !!view.pool && current.useDropPool;
      const lidarrPath = current.lidarrPath.trim();
      const done = await run('Save Lidarr', () => save.mutateAsync({
        url: current.url.trim(),
        ...(current.apiKey ? { apiKey: current.apiKey } : {}),
        ...(usePool ? {} : { rootFolderPath: current.rootFolderPath }),
        qualityProfileId: current.qualityProfileId!,
        metadataProfileId: current.metadataProfileId!,
        ...(view.pool ? { useDropPool: current.useDropPool } : {}),
        pathMap: lidarrPath && current.mapRootId ? { lidarrPath, scanRootId: current.mapRootId } : null,
      }));
      if (done) {
        setDraft(null);
        setTested(null);
      }
    } catch (err) {
      setError(errorText(err, 'Not saved'));
    }
  };

  const onDisconnect = async () => {
    if (!(await confirmDialog({ title: 'Disconnect Lidarr?', message: <p>{view.connection?.url}</p>, confirmLabel: 'Disconnect', tone: 'danger' }))) return;
    setError(null);
    try {
      const done = await run('Disconnect Lidarr', () => disconnect.mutateAsync());
      if (done) {
        setDraft(null);
        setTested(null);
      }
    } catch (err) {
      setError(errorText(err, 'Not disconnected'));
    }
  };

  return (
    <>
      <LidarrSettingsForm
        view={view}
        draft={current}
        tested={tested}
        error={error}
        testing={test.isPending}
        saving={save.isPending || disconnect.isPending}
        onChange={(d) => setDraft(d)}
        onTest={() => void onTest()}
        onSave={() => void onSave()}
        onDisconnect={() => void onDisconnect()}
        rootCheck={rootCheck.data ?? null}
      />
      {dialog}
    </>
  );
}
