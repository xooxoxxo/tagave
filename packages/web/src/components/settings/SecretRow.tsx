/**
 * A secret's row (the save model, DESIGN.md): never part of a group's Save.
 * It shows whether one is stored (`Set · ••••<hint>` or `Not set`), a
 * password field, `Set` (or `Replace`) and, once stored, quiet-danger
 * `Forget`. The stored value never comes back; the field empties once the
 * new one is saved. Integrations' Discogs token and AcoustID key.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Input, SaveStatus, SettingsRow, type SaveState } from '../ui';
import styles from './SecretRow.module.css';

export interface SecretRowProps {
  label: string;
  /** Behind a `?` beside the label (where to get one). */
  help?: ReactNode;
  /** One is stored. */
  set: boolean;
  /** The last characters of the stored one, when the server tells them. */
  hint?: string | null | undefined;
  placeholder?: string | undefined;
  /** Shorter values are not sent (the API's minimum). */
  minLength?: number | undefined;
  pending?: boolean | undefined;
  state?: SaveState | undefined;
  detail?: string | null | undefined;
  onSet: (value: string) => void;
  onForget: () => void;
}

/** `Set · ••••a1b2`, `Set`, or `Not set`. */
export function secretValue(set: boolean, hint?: string | null): string {
  if (!set) return 'Not set';
  return hint ? `Set · ••••${hint}` : 'Set';
}

export function SecretRow({ label, help, set, hint = null, placeholder, minLength = 1, pending = false, state = null, detail = null, onSet, onForget }: SecretRowProps) {
  const [value, setValue] = useState('');
  // the field empties once the new value is saved
  const was = useRef(state);
  useEffect(() => {
    if (state === 'saved' && was.current !== 'saved') setValue('');
    was.current = state;
  }, [state]);
  const ready = value.trim().length >= minLength && !pending;
  const send = () => { if (ready) onSet(value.trim()); };
  return (
    <SettingsRow as="div" label={label} help={help} value={<span className={set ? styles.value : styles.valueOff}>{secretValue(set, hint)}</span>}>
      <span className={styles.control}>
        <Input
          dense
          className={styles.field}
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
        />
        <Button size="sm" variant="secondary" loading={pending} disabled={!ready} onClick={send}>{set ? 'Replace' : 'Set'}</Button>
        {set && <Button size="sm" variant="quiet-danger" disabled={pending} onClick={onForget}>Forget</Button>}
        <SaveStatus state={state} detail={detail} />
      </span>
    </SettingsRow>
  );
}
