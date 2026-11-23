/**
 * Settings › Tag writing (M2, spec §12.8 + M2 plan Q5): the library's
 * switch for writing tags to files, and the default write policy new plans
 * start from. Writes also need a writable music folder (Settings › Library);
 * the worker re-checks both per file when a plan applies. Tag writes, the
 * preset and the MP3 tags are single choices, each saved when changed (Tag
 * writes asks first before it turns on); the separator is typed and saved
 * with its Save. A choice sends the stored policy with that one change, so
 * a typed but unsaved separator stays in its draft. TagWritingView is the
 * section alone, driven by props (stories, tests).
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { PatchLibrarySettings, TagPolicies } from '@tagave/shared';
import { docsUrl } from '../utils/docs';
import { useCurrentLibrary } from '../hooks';
import { useLibrarySettings, useUpdateLibrarySettings, useScanRoots } from '../hooks/useLibrary';
import { Input, LinkButton, SaveStatus, SegmentedControl, Select, SettingsGroup, SettingsRow, SettingsSave, confirmDialog, useSaveFlash, useSettingsDraft, type SaveFlash, type SaveState } from '../components/ui';
import styles from './SettingsTagWritesPage.module.css';

type Preset = TagPolicies['preset'];

const PRESETS: Array<{ id: Preset; title: string }> = [
  { id: 'canonical_ids_and_fill', title: 'Canonical IDs + fill' },
  { id: 'fill_blanks_only', title: 'Fill blanks only' },
  { id: 'overwrite_all', title: 'Overwrite all' },
  { id: 'custom', title: 'Custom' },
];

const DEFAULT_POLICY: TagPolicies = { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' };

const ON_OFF = [{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }];

/** The three fields this page sets, as today's Save sent them. */
const policyOf = (p: TagPolicies): TagPolicies => ({ preset: p.preset, id3Version: p.id3Version, multiValueSeparator: p.multiValueSeparator });

export interface SaveOutcome {
  state: SaveState;
  detail?: string | null;
}

export interface TagWritingViewProps {
  enabled: boolean;
  /** the paths of the music folders that allow writes; null while they load */
  writable: string[] | null;
  /** the stored policy */
  policy: TagPolicies;
  /** the separator as typed */
  separator: string;
  onWrites: (on: boolean) => void;
  /** one choice of the policy changed */
  onPolicy: (patch: Partial<TagPolicies>) => void;
  onSeparator: (value: string) => void;
  onSaveSeparator: () => void;
  /** the separator's save is on its way */
  saving?: boolean;
  writesStatus?: SaveOutcome;
  policyStatus?: SaveOutcome;
  separatorStatus?: SaveOutcome;
  /** the way to Settings › Library (a router link; left out in tests) */
  editFolders?: ReactNode;
}

export function TagWritingView({ enabled, writable, policy, separator, onWrites, onPolicy, onSeparator, onSaveSeparator, saving = false, writesStatus, policyStatus, separatorStatus, editFolders }: TagWritingViewProps) {
  // the folders a plan really writes: the library's switch on and the folder allowing writes
  const written = enabled ? writable : [];
  const folders = written === null ? 'Checking' : written.length === 0 ? 'None' : written.join(', ');
  const noFolder = enabled && writable?.length === 0;
  const dirty = separator !== policy.multiValueSeparator && separator.length > 0;
  const status = (s?: SaveOutcome) => <SaveStatus state={s?.state ?? null} detail={s?.detail ?? null} />;
  return (
    <div className={styles.page}>
      <SettingsGroup title="Tag writes" status={status(writesStatus)}>
        <SettingsRow as="div" label="Tag writes" help="Nothing is written until you apply a tag plan">
          <SegmentedControl label="Tag writes" value={enabled ? 'on' : 'off'} onChange={(v) => onWrites(v === 'on')} options={ON_OFF} />
        </SettingsRow>
        <SettingsRow as="div" label="Writable folders">
          <span className={styles.inline}>
            <span className={noFolder ? styles.problem : styles.value}>{folders}</span>
            {editFolders}
          </span>
        </SettingsRow>
      </SettingsGroup>

      <form onSubmit={(e) => { e.preventDefault(); if (dirty && !saving) onSaveSeparator(); }} noValidate>
        <SettingsGroup
          title="Default write policy"
          help={<a href={docsUrl('tag-correction.md')} target="_blank" rel="noreferrer">How to</a>}
          status={status(policyStatus)}
          after={policy.id3Version === '2.3'
            ? <div className={styles.save}><SettingsSave type="submit" dirty={dirty} pending={saving} onSave={() => undefined} state={separatorStatus?.state ?? null} detail={separatorStatus?.detail ?? null} /></div>
            : undefined}
        >
          <SettingsRow label="Preset" help="Canonical IDs + fill is recommended">
            <Select dense value={policy.preset} onChange={(e) => onPolicy({ preset: e.currentTarget.value as Preset })}>
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </Select>
          </SettingsRow>
          <SettingsRow label="MP3 tags" help="ID3v2.4 is UTF-8 and recommended; ID3v2.3 is for older players">
            <Select dense value={policy.id3Version} onChange={(e) => onPolicy({ id3Version: e.currentTarget.value as TagPolicies['id3Version'] })}>
              <option value="2.4">ID3v2.4</option>
              <option value="2.3">ID3v2.3</option>
            </Select>
          </SettingsRow>
          {policy.id3Version === '2.3' && (
            <SettingsRow label="Separator" help="Between the values of a field with more than one, in ID3v2.3">
              <Input dense className={styles.field} value={separator} spellCheck={false} autoComplete="off" onChange={(e) => onSeparator(e.currentTarget.value)} />
            </SettingsRow>
          )}
        </SettingsGroup>
      </form>
    </div>
  );
}

const detailOf = (err: unknown): string | null => (err as { detail?: string } | null)?.detail ?? null;

/** Settings › Tag writing, connected. */
export function SettingsTagWritesContent() {
  const { libraryId } = useCurrentLibrary();
  const settings = useLibrarySettings(libraryId);
  const roots = useScanRoots(libraryId);
  const update = useUpdateLibrarySettings(libraryId);
  const writesFlash = useSaveFlash();
  const policyFlash = useSaveFlash();
  const separatorFlash = useSaveFlash();
  const stored = policyOf(settings.data?.tagPolicy ?? DEFAULT_POLICY);
  const base = useMemo(() => ({ separator: stored.multiValueSeparator }), [stored.multiValueSeparator]);
  const { draft, set } = useSettingsDraft(base);
  const [last, setLast] = useState<'writes' | 'policy' | 'separator' | null>(null);
  if (!settings.data) return null;

  const send = (data: PatchLibrarySettings, part: 'writes' | 'policy' | 'separator') => {
    const flash: SaveFlash = { writes: writesFlash, policy: policyFlash, separator: separatorFlash }[part];
    setLast(part);
    flash.clear();
    update.mutate(data, { onSuccess: () => flash.saved(), onError: (err) => flash.failed(detailOf(err)) });
  };
  // while a choice saves, it shows as chosen
  const sending = update.isPending ? update.variables : undefined;
  const enabled = sending?.tagWritesEnabled ?? settings.data.tagWritesEnabled === true;
  const shown = sending?.tagPolicy ? policyOf(sending.tagPolicy) : stored;
  const separator = (draft ?? base).separator;

  const onWrites = async (on: boolean) => {
    if (on && !(await confirmDialog({ title: 'Turn on tag writes for this library?', message: 'Nothing is written until you apply a tag plan.', confirmLabel: 'Turn on' }))) return;
    send({ tagWritesEnabled: on }, 'writes');
  };

  return (
    <TagWritingView
      enabled={enabled}
      writable={roots.data ? roots.data.filter((r) => r.writable).map((r) => r.path) : roots.isError ? [] : null}
      policy={shown}
      separator={separator}
      onWrites={(on) => void onWrites(on)}
      onPolicy={(patch) => send({ tagPolicy: { ...stored, ...patch } }, 'policy')}
      onSeparator={(v) => set({ separator: v })}
      onSaveSeparator={() => send({ tagPolicy: { ...stored, multiValueSeparator: separator } }, 'separator')}
      saving={update.isPending && last === 'separator'}
      writesStatus={writesFlash}
      policyStatus={policyFlash}
      separatorStatus={separatorFlash}
      editFolders={<LinkButton variant="secondary" size="sm" to="/settings/library" aria-label="Edit music folders">Edit</LinkButton>}
    />
  );
}
