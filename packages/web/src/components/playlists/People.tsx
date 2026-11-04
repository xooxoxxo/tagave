/**
 * The people of a collaborative playlist (0079), as the account's initial
 * tiles (AccountCompartment): the header's row of the owner and the
 * collaborators, and the small tile on each item that says who added it.
 * A tile's name shows on hover, on a long press (touch) and in the
 * accessible name.
 */
import { useEffect, useRef, useState } from 'react';
import type { PlaylistPerson } from '@tagave/shared';
import { accountInitial } from '../AccountCompartment';
import { PeopleIcon } from '../ui';
import tip from '../ui/Tooltip.module.css';
import styles from './People.module.css';

const LONG_PRESS_MS = 450;

/** One person's tile; `label` is its accessible name (none: hidden from assistive tech, the name is said elsewhere). */
export function PersonTile({ person, size = 'md', label }: { person: PlaylistPerson; size?: 'sm' | 'md'; label?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (press.current) clearTimeout(press.current); press.current = null; };
  useEffect(() => {
    if (!open) return;
    const away = () => setOpen(false);
    const t = setTimeout(away, 2500);
    document.addEventListener('pointerdown', away);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', away); };
  }, [open]);
  useEffect(() => clear, []);
  return (
    <span
      className={`${styles.anchor} ${tip.anchor}`}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setOpen(true); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') setOpen(false); }}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse') return;
        clear();
        press.current = setTimeout(() => setOpen(true), LONG_PRESS_MS);
      }}
      onPointerUp={clear}
      onPointerCancel={clear}
      onContextMenu={(e) => { if (open || press.current) e.preventDefault(); }}
    >
      <span
        className={styles.tile}
        data-size={size}
        {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      >
        {accountInitial(person.name, '')}
      </span>
      <span className={[tip.tip, tip.top, open ? tip.open : ''].filter(Boolean).join(' ')} aria-hidden="true">{person.name}</span>
    </span>
  );
}

/** The header's people: the owner first, then the collaborators. */
export function PeopleRow({ owner, collaborators }: { owner: PlaylistPerson; collaborators: readonly PlaylistPerson[] }) {
  const all = [owner, ...collaborators];
  return (
    <span className={styles.row} role="group" aria-label={all.map((p) => p.name).join(', ')}>
      {all.map((p) => <PersonTile key={p.id} person={p} />)}
    </span>
  );
}

/** A list someone shares (the person's, with collaborators, or someone else's they collaborate on): an icon, its name for assistive tech. */
export function CollabMark({ className }: { className?: string | undefined }) {
  return <span className={[styles.mark, className].filter(Boolean).join(' ')} role="img" aria-label="Collaborative"><PeopleIcon /></span>;
}

/** Whether a list shows who added each item: more than one person has. */
export function showAdders(items: ReadonlyArray<{ addedBy: PlaylistPerson | null }>): boolean {
  const ids = new Set(items.map((i) => i.addedBy?.id ?? null));
  return ids.size > 1;
}
