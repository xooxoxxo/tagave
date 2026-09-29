/**
 * A name that can be edited where it stands: the plan title on the plan page
 * and the name cell in the plans list. Click the name or the pencil to edit;
 * Enter or leaving the field saves, Esc puts the old name back. Whitespace is
 * collapsed and a blank name is refused before anything is sent.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { IconButton, Input } from './ui';
import styles from './InlineRename.module.css';

export const NAME_MAX = 255;

/** The name as it will be saved: inner runs of whitespace collapsed, ends trimmed. */
export function normaliseName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Why a typed name cannot be saved, or null. Mirrors the API's checks. */
export function nameProblem(raw: string): string | null {
  const name = normaliseName(raw);
  if (!name) return 'The name cannot be empty';
  if (name.length > NAME_MAX) return `The name can be at most ${NAME_MAX} characters`;
  return null;
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M11.3 2.3a1.5 1.5 0 0 1 2.1 0l.3.3a1.5 1.5 0 0 1 0 2.1L6 12.4 2.8 13.2l.8-3.2 7.7-7.7Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function InlineRename({
  value,
  onSave,
  label = 'Rename',
  size = 'title',
}: {
  value: string;
  /** Resolves when saved; a rejection's `detail` or message is shown under the field. */
  onSave: (name: string) => Promise<unknown>;
  /** Accessible name of the edit button, e.g. "Rename plan". */
  label?: string;
  /** title: the page headline; row: a table cell. */
  size?: 'title' | 'row';
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  // Esc unmounts the field; the blur that can follow must not save.
  const cancelled = useRef(false);
  const errorId = useId();

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const start = () => {
    cancelled.current = false;
    setDraft(value);
    setError(null);
    setEditing(true);
  };
  const stop = () => {
    setEditing(false);
    setError(null);
    // Back to the pencil, so a keyboard user does not lose their place.
    requestAnimationFrame(() => editButtonRef.current?.focus());
  };
  const cancel = () => {
    cancelled.current = true;
    stop();
  };
  const commit = async () => {
    if (cancelled.current || saving) return;
    const problem = nameProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    const name = normaliseName(draft);
    if (name === value) {
      stop();
      return;
    }
    setSaving(true);
    try {
      await onSave(name);
      stop();
    } catch (e) {
      setError((e as { detail?: string; message?: string })?.detail ?? (e as Error)?.message ?? 'The name could not be saved.');
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Typing stays in the field: a clickable table row around it would take
    // Space and Enter as "open this row".
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    }
  };

  const sizeClass = size === 'title' ? styles.title : styles.row;
  const keepInside = (e: { stopPropagation: () => void }) => e.stopPropagation();

  if (!editing) {
    return (
      <span className={`${styles.wrap} ${sizeClass}`}>
        {/* In the headline the name itself is a shortcut for the pencil; in a
            row a click on the name opens the row, and only the pencil renames. */}
        <span className={styles.text} onClick={size === 'title' ? start : undefined}>{value}</span>
        <IconButton ref={editButtonRef} variant="quiet" size="sm" label={label} className={styles.edit} onKeyDown={keepInside} onClick={(e) => { e.stopPropagation(); e.preventDefault(); start(); }}>
          <PencilIcon />
        </IconButton>
      </span>
    );
  }

  return (
    <span className={`${styles.editing} ${sizeClass}`} onKeyDown={keepInside} onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}>
      <Input
        ref={inputRef}
        className={styles.input}
        dense={size === 'row'}
        value={draft}
        maxLength={NAME_MAX + 40}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        disabled={saving}
        onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
        onKeyDown={onKeyDown}
        onBlur={() => void commit()}
      />
      <span className={styles.hint}>
        {error
          ? <span id={errorId} role="alert" className={styles.error}>{error}</span>
          : saving ? 'Saving…' : 'Enter saves · Esc cancels'}
      </span>
    </span>
  );
}
