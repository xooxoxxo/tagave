/**
 * Collaborators (a playlist's ⋮, its owner only): the install's other
 * people, each Off | On. On: they see the list, play it, add to it, reorder
 * it and take out what they added. A sheet from the bottom on a phone, from
 * the right on a desktop. Loaded the first time it opens.
 */
import type { RefObject } from 'react';
import type { PlaylistCollaboratorChoice } from '@tagave/shared';
import { EmptyState, SegmentedControl, showToast, type SegmentedOption } from '../ui';
import { Sheet } from '../ui/Sheet';
import { usePlaylistCollaborators, useSetCollaborator } from '../../hooks/usePlaylists';
import { PersonTile } from './People';
import drawer from '../../pages/AlbumMenu.module.css';
import actions from '../player/TrackActions.module.css';
import styles from './CollaboratorsSheet.module.css';

const OPTIONS: SegmentedOption<'off' | 'on'>[] = [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }];

/** The list alone, driven by props (stories, tests). */
export function CollaboratorsList({ people, onChange }: { people: readonly PlaylistCollaboratorChoice[] | null; onChange: (userId: string, on: boolean) => void }) {
  if (people === null) return null;
  if (people.length === 0) return <EmptyState title="No one else here" />;
  return (
    <ul className={styles.list}>
      {people.map((p) => (
        <li key={p.id} className={styles.row}>
          <PersonTile person={p} />
          <span className={styles.name} dir="auto">{p.name}</span>
          <SegmentedControl size="sm" label={p.name} options={OPTIONS} value={p.on ? 'on' : 'off'} onChange={(v) => onChange(p.id, v === 'on')} />
        </li>
      ))}
    </ul>
  );
}

export function CollaboratorsSheet({ playlistId, open, onOpenChange, side, returnFocus }: {
  playlistId: string; open: boolean; onOpenChange: (open: boolean) => void; side: 'bottom' | 'right'; returnFocus?: RefObject<HTMLElement | null>;
}) {
  const people = usePlaylistCollaborators(playlistId, open);
  const set = useSetCollaborator(playlistId);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Collaborators" side={side} returnFocus={returnFocus}>
      <div className={drawer.sheet}>
        <div className={actions.stepHead}><span className={actions.stepTitle}>Collaborators</span></div>
        <CollaboratorsList
          people={people.data ?? null}
          onChange={(userId, on) => set.mutate({ userId, on }, { onError: () => showToast({ message: 'Not changed. Try again.', tone: 'danger' }) })}
        />
      </div>
    </Sheet>
  );
}
