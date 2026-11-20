/**
 * A save's outcome, beside what was saved (the save model, DESIGN.md):
 * `✓ Saved` as a status, or why it was not as an alert (the API's detail
 * as a sentence, else `Not saved`). An instant choice shows it in its
 * group's head; a typed group shows it beside its Save.
 */
import styles from './SettingsGroup.module.css';

export type SaveState = 'saved' | 'failed' | null;

/** "the app did not answer" → "The app did not answer." */
export function sentence(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

export interface SaveStatusProps {
  state: SaveState;
  /** The API's detail when it failed. */
  detail?: string | null;
}

export function SaveStatus({ state, detail = null }: SaveStatusProps) {
  if (state === 'saved') return <span className={styles.saved} role="status">✓ Saved</span>;
  if (state === 'failed') return <span className={styles.failed} role="alert">{sentence(detail) || 'Not saved'}</span>;
  return null;
}
