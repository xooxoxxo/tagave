/**
 * A typed group's one Save (the save model, DESIGN.md): primary, disabled
 * until the draft differs from the saved value, busy while it goes; why it
 * waits (`Set the key first`) and the save's outcome sit beside it.
 */
import { Button } from './Button';
import { SaveStatus, type SaveState } from './SaveStatus';
import styles from './SettingsGroup.module.css';

export interface SettingsSaveProps {
  /** The draft differs from the saved value. */
  dirty: boolean;
  /** The save is on its way. */
  pending?: boolean;
  onSave: () => void;
  state?: SaveState;
  /** The API's detail when it failed. */
  detail?: string | null;
  /** Why Save waits; it stays disabled while there is one. */
  reason?: string | null;
  label?: string;
  /** 'submit' leaves the press to the form's onSubmit; 'button' (default) calls onSave. */
  type?: 'submit' | 'button';
}

export function SettingsSave({ dirty, pending = false, onSave, state = null, detail = null, reason = null, label = 'Save', type = 'button' }: SettingsSaveProps) {
  return (
    <div className={styles.save}>
      <Button variant="primary" type={type} loading={pending} disabled={!dirty || !!reason} onClick={type === 'submit' ? undefined : onSave}>{label}</Button>
      {reason && <span className={styles.reason}>{reason}</span>}
      <SaveStatus state={state} detail={detail} />
    </div>
  );
}
