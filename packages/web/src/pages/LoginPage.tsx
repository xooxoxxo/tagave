/**
 * Login page (PLT-1)
 */

import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AUTH_QUERY_KEY, useLogin } from '../hooks/useAuth';
import { conditionalUiAvailable, endPasskeyRequest, signInWithPasskey } from '../services/passkeys';
import type { AuthClientError } from '../services/authClient';
import { useSetupRequired } from '../hooks/useSystem';
import { signInErrorMessage } from './loginErrors';
import { afterSignIn } from './connectReturn';
import { Button } from '../components/ui';
import styles from './LoginPage.module.css';

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const loginMutation = useLogin();
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [passkeyError, setPasskeyError] = useState<AuthClientError | null>(null);

  const passkeyDone = async () => {
    await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    afterSignIn(navigate);
  };

  // Conditional UI: the browser offers saved passkeys in the email field's
  // autofill list; picking one signs in without the password.
  useEffect(() => {
    let live = true;
    void (async () => {
      if (!(await conditionalUiAvailable()) || !live) return;
      const res = await signInWithPasskey(true);
      if (live && res.ok) await passkeyDone();
    })();
    return () => {
      live = false;
      // Leaving the page must end the autofill request: it would otherwise
      // stay open and block the next passkey request (re-verification).
      endPasskeyRequest();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const passkeySignIn = async () => {
    setPasskeyPending(true);
    setPasskeyError(null);
    const res = await signInWithPasskey(false);
    setPasskeyPending(false);
    if (!res.ok) {
      setPasskeyError(res.error ?? null);
      return;
    }
    await passkeyDone();
  };

  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });
  const [showPassword, setShowPassword] = useState(false);

  // A fresh install has no account to sign in to: start first-run setup.
  const setupRequired = useSetupRequired();
  useEffect(() => {
    if (setupRequired.data === true) navigate({ to: '/setup' });
  }, [setupRequired.data, navigate]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    loginMutation.mutate(
      { email: formData.email.trim(), password: formData.password },
      {
        onSuccess: (outcome) => {
          if (outcome.status === 'two-factor') navigate({ to: '/login/2fa' });
          else afterSignIn(navigate);
        },
      },
    );
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>tagave</h1>
        <p className={styles.subtitle}>Sign in to your music archive</p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="email" className={styles.label}>
              Email
            </label>
            <input
              id="email"
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="your@example.com"
              disabled={loginMutation.isPending}
              autoComplete="username webauthn"
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="password" className={styles.label}>
              Password
              <Button
                variant="quiet"
                size="sm"
                type="button"
                className={styles.togglePassword}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </Button>
            </label>
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              name="password"
              value={formData.password}
              onChange={handleChange}
              placeholder="Enter your password"
              disabled={loginMutation.isPending}
              autoComplete="current-password"
            />
          </div>

          {loginMutation.error && (
            <div className={styles.serverError} role="alert">
              {signInErrorMessage(loginMutation.error)}
            </div>
          )}

          <Button
            type="submit"
            className={styles.submitBtn}
            disabled={loginMutation.isPending || !formData.email || !formData.password}
          >
            {loginMutation.isPending ? 'Signing in...' : 'Sign In'}
          </Button>

          <Button
            type="button"
            variant="secondary"
            className={styles.submitBtn}
            onClick={() => void passkeySignIn()}
            loading={passkeyPending}
            disabled={loginMutation.isPending}
          >
            Sign in with a passkey
          </Button>
          {passkeyError && (
            <div className={styles.serverError} role="alert">
              {signInErrorMessage(passkeyError)}
            </div>
          )}
        </form>

        <div className={styles.footer}>
          <p>
            First time here? <a href="/setup">Create the owner account</a>.
          </p>
        </div>
      </div>
    </div>
  );
}
