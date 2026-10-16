/**
 * Second sign-in step (/login/2fa): the authenticator-app code, or a backup
 * code, after a correct email and password. "Trust this device" skips this
 * step on this browser for 30 days (revocable in Settings › Security).
 */

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../components/ui';
import { authClient, type AuthClientError } from '../services/authClient';
import { AUTH_QUERY_KEY } from '../hooks/useAuth';
import { signInErrorMessage } from './loginErrors';
import { afterSignIn } from './connectReturn';
import styles from './LoginPage.module.css';

export function TwoFactorPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'totp' | 'backup'>('totp');
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AuthClientError | null>(null);

  const ready = mode === 'totp' ? /^\d{6}$/.test(code) : code.trim().length >= 6;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const client = authClient();
    const result =
      mode === 'totp'
        ? await client.twoFactor.verifyTotp({ code, trustDevice })
        : await client.twoFactor.verifyBackupCode({ code: code.trim(), trustDevice });
    setPending(false);
    if (result.error) {
      setError(result.error);
      if (result.error.code === 'INVALID_TWO_FACTOR_COOKIE') navigate({ to: '/login' });
      return;
    }
    await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    afterSignIn(navigate);
  };

  const switchMode = () => {
    setMode(mode === 'totp' ? 'backup' : 'totp');
    setCode('');
    setError(null);
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>tagave</h1>
        <p className={styles.subtitle}>
          {mode === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your backup codes. Each works once.'}
        </p>

        <form onSubmit={submit} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="code" className={styles.label}>
              {mode === 'totp' ? 'Code' : 'Backup code'}
            </label>
            <input
              id="code"
              name="code"
              value={code}
              onChange={(e) => setCode(mode === 'totp' ? e.target.value.replace(/\D/g, '').slice(0, 6) : e.target.value)}
              inputMode={mode === 'totp' ? 'numeric' : 'text'}
              autoComplete="one-time-code"
              autoFocus
              disabled={pending}
              placeholder={mode === 'totp' ? '123456' : 'xxxxx-xxxxx'}
            />
          </div>

          <label className={styles.checkboxRow}>
            <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} disabled={pending} />
            Don't ask for a code on this device for 30 days
          </label>

          {error && (
            <div className={styles.serverError} role="alert">
              {signInErrorMessage(error)}
            </div>
          )}

          <Button type="submit" className={styles.submitBtn} disabled={pending || !ready}>
            {pending ? 'Checking...' : 'Continue'}
          </Button>
        </form>

        <div className={styles.footer}>
          <p>
            <Button variant="quiet" size="sm" type="button" onClick={switchMode}>
              {mode === 'totp' ? 'Use a backup code instead' : 'Use the authenticator app instead'}
            </Button>
          </p>
          <p>
            <a href="/login">Start over</a>
          </p>
        </div>
      </div>
    </div>
  );
}
