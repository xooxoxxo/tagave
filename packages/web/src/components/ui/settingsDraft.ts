/**
 * The save model's state (DESIGN.md): a typed group's draft against the
 * saved value, and the moment of `✓ Saved` after an instant choice.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SaveState } from './SaveStatus';

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The draft after the saved value changed under it (a save elsewhere, a
 * key set): a field still equal to `before` takes `after`'s value, a field
 * the person changed stays.
 */
export function rebaseDraft<T extends Record<string, unknown>>(draft: T, before: T, after: T): T {
  const next = { ...draft };
  for (const k of Object.keys(after) as Array<keyof T>) if (same(draft[k], before[k])) next[k] = after[k];
  return next;
}

/** The keys whose draft value differs from the saved one. */
export function changedKeys<T extends Record<string, unknown>>(draft: T, saved: T): Array<keyof T> {
  return (Object.keys(draft) as Array<keyof T>).filter((k) => !same(draft[k], saved[k]));
}

export interface SettingsDraft<T> {
  draft: T | null;
  set(patch: Partial<T>): void;
  dirty: boolean;
  changed: Array<keyof T>;
  /** Back to the saved value: after a successful save, or to drop the edits. */
  reset(): void;
}

/** A typed group's draft: starts at `saved`, rebased when `saved` changes. */
export function useSettingsDraft<T extends Record<string, unknown>>(saved: T | null): SettingsDraft<T> {
  const [draft, setDraft] = useState<T | null>(saved);
  const [base, setBase] = useState<T | null>(saved);
  let current = draft;
  if (saved !== base) {
    current = saved ? (draft && base ? rebaseDraft(draft, base, saved) : saved) : null;
    setBase(saved);
    setDraft(current);
  }
  const set = useCallback((patch: Partial<T>) => setDraft((d) => (d ? { ...d, ...patch } : d)), []);
  const reset = useCallback(() => setDraft(saved), [saved]);
  const changed = current && saved ? changedKeys(current, saved) : [];
  return { draft: current, set, dirty: changed.length > 0, changed, reset };
}

export interface SaveFlash {
  state: SaveState;
  detail: string | null;
  /** `✓ Saved` for `ms`, then nothing. */
  saved(): void;
  /** Why it was not saved; it stays until the next change. */
  failed(detail?: string | null): void;
  clear(): void;
}

/** An instant choice's outcome: `✓ Saved` for a moment (2.5 s), or why it was not. */
export function useSaveFlash(ms = 2500): SaveFlash {
  const [value, setValue] = useState<{ state: SaveState; detail: string | null }>({ state: null, detail: null });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const clear = useCallback(() => {
    clearTimeout(timer.current);
    setValue({ state: null, detail: null });
  }, []);
  const saved = useCallback(() => {
    clearTimeout(timer.current);
    setValue({ state: 'saved', detail: null });
    timer.current = setTimeout(() => setValue({ state: null, detail: null }), ms);
  }, [ms]);
  const failed = useCallback((detail: string | null = null) => {
    clearTimeout(timer.current);
    setValue({ state: 'failed', detail });
  }, []);
  return { state: value.state, detail: value.detail, saved, failed, clear };
}
