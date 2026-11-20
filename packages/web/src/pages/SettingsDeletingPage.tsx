/**
 * Settings › Library › Deleting: Mark (the default) or Trash, one at a time,
 * so every ⋮ shows one delete item. Trash only while a music folder is
 * writable (its setting and the worker's check); a folder that is not marks
 * its files instead. The choice saves when changed, its outcome in the
 * group's head.
 */
import type { DeleteMode } from '@tagave/shared';
import { useCurrentLibrary } from '../hooks';
import { useDeleteMode, useSetDeleteMode } from '../hooks/useDeletions';
import { LinkButton, SaveStatus, SegmentedControl, SettingsGroup, SettingsRow, useSaveFlash, type SaveState } from '../components/ui';
import styles from './SettingsDeletingPage.module.css';

export interface DeletingViewProps {
  mode: DeleteMode;
  /** a music folder may be written to */
  trashAvailable: boolean;
  onChange: (mode: DeleteMode) => void;
  state?: SaveState;
  detail?: string | null;
}

/** The group alone, driven by props (stories). */
export function DeletingView({ mode, trashAvailable, onChange, state = null, detail = null }: DeletingViewProps) {
  return (
    <SettingsGroup
      title="Deleting"
      help="Mark lists a file in Library care › Deleting; Trash moves it to the music folder's trash"
      status={<SaveStatus state={state} detail={detail} />}
      after={<div className={styles.link}><LinkButton variant="secondary" size="sm" to="/work" search={{ tab: 'deleting' } as never}>Library care › Deleting</LinkButton></div>}
    >
      <SettingsRow as="div" label="Deleting" value={!trashAvailable ? <span className={styles.value}>Music folders: read-only</span> : undefined}>
        <SegmentedControl<DeleteMode>
          label="Deleting"
          value={mode}
          onChange={onChange}
          options={[
            { value: 'mark', label: 'Mark' },
            { value: 'trash', label: 'Trash', disabled: !trashAvailable },
          ]}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

export function SettingsDeletingContent() {
  const { libraryId } = useCurrentLibrary();
  const current = useDeleteMode(libraryId);
  const set = useSetDeleteMode(libraryId);
  const flash = useSaveFlash();
  if (!current) return null;
  const choose = (mode: DeleteMode) => {
    flash.clear();
    set.mutate(mode, {
      onSuccess: () => flash.saved(),
      onError: (err) => flash.failed((err as { detail?: string } | null)?.detail ?? null),
    });
  };
  return (
    <DeletingView
      mode={set.isPending && set.variables ? set.variables : current.mode}
      trashAvailable={current.trashAvailable}
      onChange={choose}
      state={flash.state}
      detail={flash.detail}
    />
  );
}
