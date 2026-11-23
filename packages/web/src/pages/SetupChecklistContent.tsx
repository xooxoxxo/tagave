/**
 * The setup checklist: Home shows it on first run (setupChecklist.ts);
 * Settings keeps its route, out of the nav. Five steps, each a settings
 * group with its state (Done, Required, Optional) in the head, built from
 * the settings pages' own rows: Contact and the two keys are Modules ›
 * Integrations' (Contact with its own Save; the keys as secret rows with
 * Set / Replace / Forget), the music folder is Settings › Library's Add
 * music folder, and First scan is an action. SetupChecklistView is the
 * checklist alone, driven by props (tests); SetupChecklistContent connects it.
 */
import { useMemo } from 'react';
import type { LibrarySettingsView, ScanRoot } from '@tagave/shared';
import { useCurrentLibrary, useScanRoots, useCreateScanRoot, useStartScan } from '../hooks';
import { useLibrarySettings, useUpdateLibrarySettings } from '../hooks/useLibrary';
import { Badge, Button, SettingsGroup, SettingsRow, useSettingsDraft } from '../components/ui';
import { AcoustidKeyRow, ContactRow, DiscogsTokenRow, askForgetSecret, useSave, type IntegrationSave, type IntegrationSecret } from './SettingsProvidersPage';
import { AddMusicFolder, folderCheck, type MusicFoldersViewProps } from './SettingsScanRootsPage';
import styles from './SetupChecklistContent.module.css';

export interface SetupChecklistViewProps {
  settings: Pick<LibrarySettingsView, 'contactString' | 'discogsTokenSet' | 'discogsTokenHint' | 'acoustidKeySet' | 'acoustidKeyHint' | 'onboardingCompletedAt'>;
  roots: ScanRoot[];
  /** the Contact's draft */
  contact: string;
  onContact: (value: string) => void;
  onSaveContact: (body: { contactString: string }) => void;
  contactStatus?: IntegrationSave;
  secrets?: Partial<Record<IntegrationSecret, IntegrationSave>>;
  onSetSecret: (key: IntegrationSecret, value: string) => void;
  onForgetSecret: (key: IntegrationSecret) => void;
  adding?: boolean;
  addError?: string | null;
  onAdd: MusicFoldersViewProps['onAdd'];
  onStartScan: () => void;
  starting?: boolean;
}

type StepState = 'done' | 'required' | 'optional';

function StepBadge({ state }: { state: StepState }) {
  if (state === 'done') return <Badge tone="success">Done</Badge>;
  return state === 'required' ? <Badge tone="danger">Required</Badge> : <Badge tone="info">Optional</Badge>;
}

const stateOf = (done: boolean, required: boolean): StepState => (done ? 'done' : required ? 'required' : 'optional');

export function SetupChecklistView({
  settings, roots, contact, onContact, onSaveContact, contactStatus, secrets = {}, onSetSecret, onForgetSecret,
  adding = false, addError = null, onAdd, onStartScan, starting = false,
}: SetupChecklistViewProps) {
  const checked = roots.filter((r) => r.validationStatus === 'ok');
  const scanned = !!settings.onboardingCompletedAt;
  return (
    <div className={styles.checklist}>
      <SettingsGroup title="Contact" meta={<StepBadge state={stateOf(!!settings.contactString, true)} />}>
        <ContactRow stored={settings.contactString} contact={contact} onContact={onContact} onSaveContact={onSaveContact} status={contactStatus} />
      </SettingsGroup>

      <SettingsGroup
        title="Music folder"
        meta={<StepBadge state={stateOf(checked.length > 0, true)} />}
        after={<AddMusicFolder adding={adding} error={addError} onAdd={onAdd} />}
      >
        {roots.length > 0 && roots.map((root) => {
          const check = folderCheck(root);
          return (
            <SettingsRow
              key={root.id}
              as="div"
              label={root.displayName}
              value={<span className={styles.folder}><code className={styles.path}>{root.path}</code><span className={check.problem ? styles.problem : styles.value}>{check.text}</span></span>}
            />
          );
        })}
      </SettingsGroup>

      <SettingsGroup title="Discogs token" meta={<StepBadge state={stateOf(settings.discogsTokenSet, false)} />}>
        <DiscogsTokenRow set={settings.discogsTokenSet} hint={settings.discogsTokenHint} status={secrets.discogsToken} onSet={(v) => onSetSecret('discogsToken', v)} onForget={() => onForgetSecret('discogsToken')} />
      </SettingsGroup>

      <SettingsGroup title="AcoustID key" meta={<StepBadge state={stateOf(settings.acoustidKeySet, false)} />}>
        <AcoustidKeyRow set={settings.acoustidKeySet} hint={settings.acoustidKeyHint} status={secrets.acoustidKey} onSet={(v) => onSetSecret('acoustidKey', v)} onForget={() => onForgetSecret('acoustidKey')} />
      </SettingsGroup>

      <SettingsGroup
        title="First scan"
        meta={<StepBadge state={stateOf(scanned, true)} />}
        after={scanned ? undefined : (
          <div className={styles.actions}>
            <Button size="sm" onClick={onStartScan} loading={starting} disabled={checked.length === 0 || starting}>Start scan</Button>
          </div>
        )}
      />
    </div>
  );
}

const detailOf = (err: unknown): string => (err as { detail?: string } | null)?.detail ?? '';

/** The setup checklist, connected. */
export function SetupChecklistContent() {
  const { libraryId } = useCurrentLibrary();
  const { data: settings, isLoading: settingsLoading } = useLibrarySettings(libraryId);
  const update = useUpdateLibrarySettings(libraryId);
  const { data: roots = [] } = useScanRoots(libraryId);
  const create = useCreateScanRoot(libraryId);
  const startScan = useStartScan(libraryId);
  const base = useMemo(() => (settings ? { contactString: settings.contactString ?? '' } : null), [settings]);
  const { draft, set } = useSettingsDraft(base);
  const contact = useSave();
  const discogs = useSave();
  const acoustid = useSave();
  const secretSave = { discogsToken: discogs, acoustidKey: acoustid };

  if (settingsLoading || !libraryId || !settings || !draft) return null;

  const startFirstScan = async () => {
    const checked = roots.filter((r) => r.validationStatus === 'ok');
    const root = checked.find((r) => !r.lastScanAt) ?? checked[0];
    if (!root) return;
    try {
      await startScan.mutateAsync(root.id);
      await update.mutateAsync({ onboardingCompletedAt: new Date().toISOString() });
    } catch {
      // the scan's own state shows on Settings › Library
    }
  };

  return (
    <SetupChecklistView
      settings={settings}
      roots={roots}
      contact={draft.contactString}
      onContact={(v) => set({ contactString: v })}
      onSaveContact={(body) => void contact.go(() => update.mutateAsync(body))}
      contactStatus={contact.status}
      secrets={{ discogsToken: discogs.status, acoustidKey: acoustid.status }}
      onSetSecret={(key, value) => void secretSave[key].go(() => update.mutateAsync({ [key]: value }))}
      onForgetSecret={(key) => void (async () => { if (await askForgetSecret(key)) await secretSave[key].go(() => update.mutateAsync({ [key]: null })); })()}
      adding={create.isPending}
      addError={create.error ? detailOf(create.error) || 'Not added' : null}
      onAdd={(f) => new Promise((resolve) => create.mutate({ ...f, enabled: true }, { onSuccess: () => resolve(true), onError: () => resolve(false) }))}
      onStartScan={() => void startFirstScan()}
      starting={startScan.isPending}
    />
  );
}
