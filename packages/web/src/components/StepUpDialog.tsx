/**
 * "Confirm it is you": the re-verification a sensitive action asks for when
 * the last sign-in is older than five minutes. It offers the strongest
 * method the account has first (passkey or security key, then the
 * authenticator app; the password only for an account with neither) and
 * lets the owner switch between the ones they have at any time.
 *
 * A passkey request can be stopped: Cancel, switching method or closing the
 * dialog ends it, and it stops on its own after PASSKEY_TIMEOUT_MS. Every
 * failure is shown in the dialog.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { StepUpMethod } from '@tagave/shared';
import { Button, TextField } from './ui';
import { PASSKEY_TIMEOUT_MS, stepUpErrorMessage, stepUpWithPasskey, stepUpWithPassword, stepUpWithTotp } from '../services/stepUp';
import styles from './StepUpDialog.module.css';

const LABEL: Record<StepUpMethod, string> = {
  passkey: 'Use a passkey or security key',
  totp: 'Use the authenticator app',
  password: 'Use your password',
};

export interface StepUpDialogProps {
  /** What the confirmation is for, e.g. "Update to 0.8.0". */
  action: string;
  methods: StepUpMethod[];
  onDone: () => void;
  onCancel: () => void;
}

export function StepUpDialog({ action, methods, onDone, onCancel }: StepUpDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [method, setMethod] = useState<StepUpMethod | undefined>(methods[0]);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The request in flight; aborting it ends the browser's passkey prompt too.
  const pending = useRef<AbortController | null>(null);

  const stop = () => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
  };

  useEffect(() => () => pending.current?.abort(), []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement as HTMLElement | null;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    return () => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const pick = (m: StepUpMethod) => {
    stop();
    setMethod(m);
    setValue('');
    setError(null);
  };

  const cancel = () => {
    stop();
    onCancel();
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!method || busy) return;
    const ctrl = new AbortController();
    pending.current = ctrl;
    setBusy(true);
    setError(null);
    const timer = method === 'passkey'
      ? setTimeout(() => ctrl.abort(new DOMException('No passkey answered in time.', 'TimeoutError')), PASSKEY_TIMEOUT_MS)
      : undefined;
    try {
      if (method === 'passkey') await stepUpWithPasskey(ctrl.signal);
      else if (method === 'totp') await stepUpWithTotp(value, ctrl.signal);
      else await stepUpWithPassword(value, ctrl.signal);
      if (pending.current !== ctrl) return;
      pending.current = null;
      onDone();
    } catch (err) {
      // Cancelled or replaced by another method: nothing to report.
      if (pending.current !== ctrl) return;
      pending.current = null;
      setError(stepUpErrorMessage(ctrl.signal.aborted ? ctrl.signal.reason : err));
      setBusy(false);
    } finally {
      clearTimeout(timer);
    }
  };

  const others = methods.filter((m) => m !== method);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); cancel(); }}
      onClick={(e) => { if (e.target === ref.current) cancel(); }}
    >
      <form className={styles.panel} onSubmit={submit}>
        <h2 id={titleId} className={styles.title}>Confirm it is you</h2>
        <p className={styles.message}>
          {action} needs a fresh confirmation: your last sign-in was more than five minutes ago.
        </p>
        {!method && (
          <p className={styles.error} role="alert">
            This account has no way to confirm here. Sign out and sign in again, then start the update within five minutes.
          </p>
        )}
        {method === 'passkey' && (
          <p className={styles.message} role={busy ? 'status' : undefined}>
            {busy ? 'Waiting for your passkey or security key…' : 'Your browser asks for the passkey or security key, with its PIN or fingerprint.'}
          </p>
        )}
        {method === 'totp' && (
          <TextField
            label="Code from your authenticator app"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]*"
            maxLength={7}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        {method === 'password' && (
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {others.length > 0 && (
          <div className={styles.switch}>
            {others.map((m) => (
              <Button key={m} type="button" size="sm" variant="quiet" onClick={() => pick(m)}>{LABEL[m]}</Button>
            ))}
          </div>
        )}
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={cancel}>Cancel</Button>
          {method && (
            <Button type="submit" variant="primary" loading={busy} disabled={busy || (method !== 'passkey' && value.trim() === '')}>
              {method === 'passkey' ? 'Use passkey' : 'Confirm'}
            </Button>
          )}
        </div>
      </form>
    </dialog>
  );
}
