/**
 * Settings › Follow rules (spec XO-301 GAP-2): the library's rules for
 * following an artist's discography. A release type is one tick of a
 * multi-choice list, saved when ticked (the outcome in its group's head);
 * Auto-follow at is typed and saved with its group's Save. A tick sends the
 * stored rules with that one change, so a typed but unsaved number stays in
 * its draft. FollowRulesView is the section alone, driven by props
 * (stories, tests).
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useCurrentLibrary } from '../hooks';
import { useFollowRules, usePatchFollowRules, type FollowRules } from '../hooks/useArtists';
import { Input, SaveStatus, SettingsGroup, SettingsRow, SettingsSave, useSaveFlash, useSettingsDraft, type SaveState } from '../components/ui';
import styles from './SettingsFollowRulesPage.module.css';

const PRIMARY_TYPES = ['Album', 'EP', 'Single'];
const SECONDARY_TYPES = ['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Soundtrack'];

/** Which group the last change was in: its head (or its Save) shows the outcome. */
export type FollowRulesGroup = 'include' | 'exclude' | 'auto';

export interface SaveOutcome {
  state: SaveState;
  detail?: string | null;
}

export interface FollowRulesViewProps {
  /** the stored rules */
  rules: FollowRules;
  /** Auto-follow at, as typed */
  autoFollow: number;
  onRules: (next: FollowRules, group: FollowRulesGroup) => void;
  onAutoFollow: (n: number) => void;
  onSaveAutoFollow: () => void;
  /** a save is on its way */
  pending?: boolean;
  /** where the last change was */
  changed?: FollowRulesGroup;
  /** the last save's outcome */
  status?: SaveOutcome;
}

const clamp = (n: number) => Math.max(1, Math.min(10, Number.isFinite(n) ? Math.trunc(n) : 1));

export function FollowRulesView({ rules, autoFollow, onRules, onAutoFollow, onSaveAutoFollow, pending = false, changed = 'include', status }: FollowRulesViewProps) {
  const outcome = (group: FollowRulesGroup) => (changed === group ? status : undefined);
  const head = (group: FollowRulesGroup) => <SaveStatus state={outcome(group)?.state ?? null} detail={outcome(group)?.detail ?? null} />;
  const tick = (key: 'includePrimary' | 'excludeSecondary', type: string, on: boolean, group: FollowRulesGroup) => {
    const rest = rules[key].filter((t) => t !== type);
    onRules({ ...rules, [key]: on ? [...rest, type] : rest }, group);
  };
  const dirty = autoFollow !== rules.autoFollowMinAlbums;
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (dirty && !pending) onSaveAutoFollow();
  };
  return (
    <div className={styles.page}>
      <SettingsGroup title="Include" help="The release types a followed artist's discography counts" status={head('include')}>
        {PRIMARY_TYPES.map((type) => (
          <SettingsRow key={type} label={type}>
            <input type="checkbox" className={styles.check} checked={rules.includePrimary.includes(type)} onChange={(e) => tick('includePrimary', type, e.currentTarget.checked, 'include')} />
          </SettingsRow>
        ))}
      </SettingsGroup>
      <SettingsGroup title="Exclude" help="Releases of these kinds are left out, whatever their type" status={head('exclude')}>
        {SECONDARY_TYPES.map((type) => (
          <SettingsRow key={type} label={type}>
            <input type="checkbox" className={styles.check} checked={rules.excludeSecondary.includes(type)} onChange={(e) => tick('excludeSecondary', type, e.currentTarget.checked, 'exclude')} />
          </SettingsRow>
        ))}
      </SettingsGroup>
      <form onSubmit={save} noValidate>
        <SettingsGroup
          title="Auto-follow"
          help="An artist with this many albums in the library is followed"
          after={<div className={styles.save}><SettingsSave type="submit" dirty={dirty} pending={pending && changed === 'auto'} onSave={() => undefined} state={outcome('auto')?.state ?? null} detail={outcome('auto')?.detail ?? null} /></div>}
        >
          <SettingsRow label="Auto-follow at">
            <span className={styles.number}>
              <Input dense type="number" min={1} max={10} className={styles.field} value={autoFollow} onChange={(e) => onAutoFollow(clamp(parseInt(e.currentTarget.value, 10)))} />
              <span className={styles.suffix}>albums</span>
            </span>
          </SettingsRow>
        </SettingsGroup>
      </form>
    </div>
  );
}

const detailOf = (err: unknown): string | null => (err as { detail?: string } | null)?.detail ?? null;

/** Settings › Follow rules, connected; nothing until the rules load. */
export function SettingsFollowRulesContent() {
  const { libraryId } = useCurrentLibrary();
  const { data: stored } = useFollowRules(libraryId);
  const patch = usePatchFollowRules(libraryId);
  const flash = useSaveFlash();
  const [changed, setChanged] = useState<FollowRulesGroup>('include');
  // a tick shows at once; the stored rules replace it once saved
  const [sent, setSent] = useState<FollowRules | null>(null);
  const base = useMemo(() => (stored ? { autoFollow: stored.autoFollowMinAlbums } : null), [stored]);
  const { draft, set } = useSettingsDraft(base);
  if (!stored || !draft) return null;
  const rules = sent ?? stored;

  const send = (next: FollowRules, group: FollowRulesGroup) => {
    setChanged(group);
    setSent(group === 'auto' ? null : next);
    flash.clear();
    patch.mutate(next, {
      onSuccess: () => flash.saved(),
      onError: (err) => flash.failed(detailOf(err)),
      onSettled: () => setSent(null),
    });
  };

  return (
    <FollowRulesView
      rules={rules}
      autoFollow={draft.autoFollow}
      onRules={send}
      onAutoFollow={(n) => set({ autoFollow: n })}
      onSaveAutoFollow={() => send({ ...stored, autoFollowMinAlbums: draft.autoFollow }, 'auto')}
      pending={patch.isPending}
      changed={changed}
      status={flash}
    />
  );
}
