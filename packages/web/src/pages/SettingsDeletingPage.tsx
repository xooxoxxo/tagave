/**
 * Settings › Library › Deleting: Mark (the default) or Trash, one at a time,
 * so every ⋮ shows one delete item. Trash only while a music folder is
 * writable (its setting and the worker's check); a folder that is not marks
 * its files instead.
 */
import type { DeleteMode } from '@tagave/shared';
import { useCurrentLibrary } from '../hooks';
import { useDeleteMode, useSetDeleteMode } from '../hooks/useDeletions';
import { LinkButton, SegmentedControl } from '../components/ui';
import styles from './SettingsDeletingPage.module.css';

export function SettingsDeletingContent() {
  const { libraryId } = useCurrentLibrary();
  const current = useDeleteMode(libraryId);
  const set = useSetDeleteMode(libraryId);
  return (
    <>
      <h2>Deleting</h2>
      {current && (
        <div className={styles.setting}>
          <SegmentedControl<DeleteMode>
            label="Deleting"
            value={set.isPending && set.variables ? set.variables : current.mode}
            onChange={(mode) => set.mutate(mode)}
            options={[
              { value: 'mark', label: 'Mark' },
              { value: 'trash', label: 'Trash', disabled: !current.trashAvailable },
            ]}
          />
          {!current.trashAvailable && <p className={styles.value}>Music folders: read-only</p>}
          {set.isError && <p className={styles.error} role="alert">Not saved. Try again.</p>}
          <LinkButton variant="secondary" size="sm" to="/work" search={{ tab: 'deleting' } as never}>Library care › Deleting</LinkButton>
        </div>
      )}
    </>
  );
}
