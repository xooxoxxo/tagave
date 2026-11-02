/**
 * Removing a record from the physical collection, with a few seconds to take
 * it back. The row goes at once and a toast offers Undo; only when the toast
 * has had its time does tagave ask the server to remove it (which takes it
 * off Discogs too, and that cannot be taken back). Nothing is sent before
 * then, so Undo needs no server round trip and can never half-fail.
 *
 * The wait lives here, outside React: leaving the page, or the row
 * unmounting because it was hidden, does not cancel a removal. Closing the
 * tab sends whatever is still waiting (keepalive), so a removal the owner
 * saw happen does happen.
 *
 * Owner, 2026-10-28: "let's maybe have like an undo for couple seconds but
 * then the user can enter it again so no need [for Removed]".
 */
import { useSyncExternalStore } from 'react';

/** How long Undo is offered before the record is removed for real. */
export const UNDO_MS = 5000;

type Commit = (opts: { keepalive: boolean }) => Promise<void>;

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  commit: Commit;
  onFailed: (err: unknown) => void;
}

const pending = new Map<string, Pending>();
let hidden: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

function setHidden(id: string, on: boolean) {
  if (hidden.has(id) === on) return;
  const next = new Set(hidden);
  if (on) next.add(id); else next.delete(id);
  hidden = next;
  emit();
}

function run(id: string, keepalive: boolean) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  p.commit({ keepalive }).then(
    // the list has refetched without it (a record on its way off Discogs is
    // not listed); unhidden, so a removal Discogs refuses later shows again
    () => setHidden(id, false),
    (err: unknown) => {
      // it is still there: show it again and say why
      setHidden(id, false);
      p.onFailed(err);
    },
  );
}

/**
 * Hide the record now and remove it after `ms` unless `undoRemoval(id)` is
 * called first. `commit` resolves once the list has refetched without the
 * record; a failed one brings it back.
 */
export function scheduleRemoval(id: string, commit: Commit, onFailed: (err: unknown) => void, ms = UNDO_MS): void {
  if (pending.has(id)) return;
  setHidden(id, true);
  pending.set(id, { timer: setTimeout(() => run(id, false), ms), commit, onFailed });
}

/** Take a waiting removal back: the record shows again. False once it was sent. */
export function undoRemoval(id: string): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  setHidden(id, false);
  return true;
}

/** Send every waiting removal now (the page is going away). */
export function flushRemovals(): void {
  for (const id of [...pending.keys()]) run(id, true);
}

/** Whether a removal is waiting for its Undo window (tests). */
export function isPendingRemoval(id: string): boolean {
  return pending.has(id);
}

/** The hidden records now (tests). */
export const hiddenRemovals = (): ReadonlySet<string> => hidden;

/** The records waiting to be removed (or being removed): the list leaves them out. */
export function useHiddenRemovals(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => hidden, () => hidden);
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushRemovals);
