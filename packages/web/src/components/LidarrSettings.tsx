/**
 * Settings › Connections › Lidarr (owner; the lidarr module): the module's
 * Off/On, the address and API key, Test, then the root folder and the two
 * profiles from what Test found, Save and Disconnect. The key is sent,
 * never shown: the field says only whether one is saved. Switching,
 * saving and disconnecting ask for a fresh confirmation (useStepUpAction).
 * A root folder outside every music folder, or an import that landed
 * outside them, shows the warning with the music folders.
 */
import { useState, type FormEvent } from 'react';
import type { LidarrSettingsView, LidarrTestResult } from '@tagave/shared';
import { Banner, Button, SegmentedControl, Select, TextField, confirmDialog } from './ui';
import { useDisconnectLidarr, useLidarrSettings, useSaveLidarr, useSetLidarrModule, useTestLidarr } from '../hooks/useLidarr';
import { useStepUpAction } from './users/useStepUpAction';
import styles from './LidarrSettings.module.css';

const ON_OFF = [{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }];

export interface LidarrDraft {
  url: string;
  apiKey: string;
  rootFolderPath: string;
  qualityProfileId: number | null;
  metadataProfileId: number | null;
}

export function draftOf(view: LidarrSettingsView): LidarrDraft {
  const c = view.connection;
  return { url: c?.url ?? '', apiKey: '', rootFolderPath: c?.rootFolderPath ?? '', qualityProfileId: c?.qualityProfileId ?? null, metadataProfileId: c?.metadataProfileId ?? null };
}

export interface LidarrSettingsFormProps {
  view: LidarrSettingsView;
  draft: LidarrDraft;
  tested: LidarrTestResult | null;
  error: string | null;
  testing?: boolean;
  saving?: boolean;
  switching?: boolean;
  onChange: (d: LidarrDraft) => void;
  onTest: () => void;
  onSave: () => void;
  onDisconnect: () => void;
  onSwitch: (on: boolean) => void;
  headingClassName?: string | undefined;
}

/** The form without data fetching (Storybook renders it with fixtures). */
export function LidarrSettingsForm({ view, draft, tested, error, testing = false, saving = false, switching = false, onChange, onTest, onSave, onDisconnect, onSwitch, headingClassName }: LidarrSettingsFormProps) {
  const set = <K extends keyof LidarrDraft>(k: K, v: LidarrDraft[K]) => onChange({ ...draft, [k]: v });
  const c = view.connection;
  // the selects: what Test found, else what is saved
  const folders = tested?.rootFolders ?? (c ? [c.rootFolderPath] : []);
  const quality = tested?.qualityProfiles ?? (c ? [{ id: c.qualityProfileId, name: c.qualityProfileName ?? `#${c.qualityProfileId}` }] : []);
  const metadata = tested?.metadataProfiles ?? (c ? [{ id: c.metadataProfileId, name: c.metadataProfileName ?? `#${c.metadataProfileId}` }] : []);
  const choices = !!tested || !!c;
  const ready = draft.url.trim() && (draft.apiKey || c?.keySaved) && draft.rootFolderPath && draft.qualityProfileId !== null && draft.metadataProfileId !== null;
  const version = tested?.version ?? c?.version ?? null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) onSave();
  };
  return (
    <section className={styles.section} aria-labelledby="connections-lidarr">
      <div className={[styles.titleRow, headingClassName].filter(Boolean).join(' ')}>
        <h2 id="connections-lidarr">Lidarr</h2>
      </div>
      <div className={styles.field}>
        <span className={styles.label} aria-hidden="true">Get missing albums</span>
        <SegmentedControl label="Get missing albums" value={view.enabled ? 'on' : 'off'} onChange={(v) => { if (!switching) onSwitch(v === 'on'); }} options={ON_OFF} />
      </div>
      {c?.keyUnreadable && <Banner tone="warning">Enter the API key again.</Banner>}
      {view.rootFolderOutside && view.scanRoots.length > 0 && (
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
          <label className={styles.field}>
            <span className={styles.label}>Root folder</span>
            <Select value={draft.rootFolderPath} onChange={(e) => set('rootFolderPath', e.target.value)}>
              {!draft.rootFolderPath && <option value="">Choose</option>}
              {folders.map((f) => <option key={f} value={f}>{f}</option>)}
            </Select>
          </label>
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
        </>}
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

export function LidarrSettings({ headingClassName }: { headingClassName?: string | undefined } = {}) {
  const settings = useLidarrSettings();
  const test = useTestLidarr();
  const save = useSaveLidarr();
  const disconnect = useDisconnectLidarr();
  const switchModule = useSetLidarrModule();
  const { run, dialog } = useStepUpAction();
  const [draft, setDraft] = useState<LidarrDraft | null>(null);
  const [tested, setTested] = useState<LidarrTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const done = await run('Save Lidarr', () => save.mutateAsync({
        url: current.url.trim(),
        ...(current.apiKey ? { apiKey: current.apiKey } : {}),
        rootFolderPath: current.rootFolderPath,
        qualityProfileId: current.qualityProfileId!,
        metadataProfileId: current.metadataProfileId!,
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

  const onSwitch = async (on: boolean) => {
    setError(null);
    try {
      await run(on ? 'Turn on Lidarr' : 'Turn off Lidarr', () => switchModule.mutateAsync(on));
    } catch (err) {
      setError(errorText(err, 'Not changed'));
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
        switching={switchModule.isPending}
        onChange={(d) => setDraft(d)}
        onTest={() => void onTest()}
        onSave={() => void onSave()}
        onDisconnect={() => void onDisconnect()}
        onSwitch={(on) => void onSwitch(on)}
        headingClassName={headingClassName}
      />
      {dialog}
    </>
  );
}
