/**
 * First-run setup (PLT-4), steps 1–2 of 4: check that the install can work,
 * then create the owner account. Steps 3–4 (music folder, first identified
 * album) continue on /onboarding, which needs the session this creates.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSetup } from '../hooks/useAuth';
import { useHealthChecks, useSetupRequired } from '../hooks/useSystem';
import { Banner, Button, TextField } from '../components/ui';
import { SetupSteps } from '../components/SetupSteps';
import { SystemCheckList } from '../components/SystemCheckList';
import {
  infrastructureChecks,
  normalizeAccount,
  setupBlocked,
  validateAccount,
  type AccountErrors,
  type AccountForm,
} from './setupWizard';
import styles from './SetupPage.module.css';

type Screen = 'System check' | 'Owner account';

export function SetupPage() {
  const navigate = useNavigate();
  const setupRequired = useSetupRequired();
  const [screen, setScreen] = useState<Screen>('System check');

  // Only a definite "already set up" leaves the wizard. An error is unknown:
  // the system check below shows what is wrong.
  useEffect(() => {
    if (setupRequired.data === false) navigate({ to: '/login' });
  }, [setupRequired.data, navigate]);

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>Set up tagave</h1>
        <SetupSteps current={screen} />
        {screen === 'System check' ? (
          <SystemCheckScreen onContinue={() => setScreen('Owner account')} />
        ) : (
          <AccountScreen onBack={() => setScreen('System check')} onDone={() => navigate({ to: '/onboarding' })} />
        )}
      </div>
    </div>
  );
}

function SystemCheckScreen({ onContinue }: { onContinue: () => void }) {
  const health = useHealthChecks();
  const checks = infrastructureChecks(health.data ?? []);
  const blocked = setupBlocked(checks);
  const problems = checks.filter((c) => c.status !== 'pass');

  return (
    <section aria-labelledby="check-heading" className={styles.section}>
      <h2 id="check-heading" className={styles.heading}>Is everything running?</h2>
      <p className={styles.lead}>
        tagave needs its database and at least one worker. The worker is the process that reads your music files; it can
        run on this machine or another one.
      </p>

      {health.isLoading && <p className={styles.muted} role="status">Checking the database and workers…</p>}

      {health.isError && (
        <Banner tone="danger">
          The app could not run its checks. Postgres may be down or unreachable: check that the database is running and
          that DATABASE_URL in the app environment is right, then check again.
        </Banner>
      )}

      {health.data && (
        <>
          {problems.length === 0 ? (
            <Banner tone="success">The database is ready and a worker is running.</Banner>
          ) : blocked ? (
            <Banner tone="danger">Fix the failed checks below before creating the account.</Banner>
          ) : (
            <Banner tone="warning">
              You can create the account now. Scanning waits until the checks below pass.
            </Banner>
          )}
          <SystemCheckList checks={checks} />
        </>
      )}

      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => void health.refetch()} loading={health.isFetching}>
          {health.isFetching ? 'Checking…' : 'Check again'}
        </Button>
        <Button onClick={onContinue} disabled={!health.data || blocked}>
          Continue
        </Button>
      </div>
    </section>
  );
}

function AccountScreen({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const setupMutation = useSetup();
  const [form, setForm] = useState<AccountForm>({ email: '', password: '', displayName: '', contactString: '' });
  const [errors, setErrors] = useState<AccountErrors>({});
  const [showPassword, setShowPassword] = useState(false);

  const change = (field: keyof AccountForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const found = validateAccount(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setupMutation.mutate(normalizeAccount(form), { onSuccess: onDone });
  };

  const serverError = setupMutation.error as { status?: number; detail?: string } | null;

  return (
    <section aria-labelledby="account-heading" className={styles.section}>
      <h2 id="account-heading" className={styles.heading}>Create the owner account</h2>
      <p className={styles.lead}>This is the account you sign in with. It can change everything in this tagave.</p>

      <form onSubmit={submit} className={styles.form} noValidate>
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={form.email}
          onChange={change('email')}
          error={errors.email}
          placeholder="you@example.com"
          disabled={setupMutation.isPending}
        />
        <TextField
          label="Your name"
          autoComplete="name"
          required
          value={form.displayName}
          onChange={change('displayName')}
          error={errors.displayName}
          disabled={setupMutation.isPending}
        />
        <div className={styles.passwordField}>
          <TextField
            label="Password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            required
            value={form.password}
            onChange={change('password')}
            error={errors.password}
            hint="At least 8 characters."
            disabled={setupMutation.isPending}
          />
          <Button variant="quiet" size="sm" type="button" className={styles.togglePassword} onClick={() => setShowPassword((v) => !v)}>
            {showPassword ? 'Hide password' : 'Show password'}
          </Button>
        </div>
        <TextField
          label="Contact for metadata services"
          required
          value={form.contactString}
          onChange={change('contactString')}
          error={errors.contactString}
          hint="MusicBrainz and Discogs ask every app to say who is calling. Your email address or website is sent with each lookup; nothing else is shared."
          placeholder="you@example.com or https://example.com"
          disabled={setupMutation.isPending}
        />

        {serverError && (
          <Banner tone="danger">
            {serverError.status === 409
              ? 'An owner account already exists. Sign in instead.'
              : serverError.detail || 'The account could not be created. Check the fields above and try again.'}
          </Banner>
        )}

        <div className={styles.actions}>
          <Button variant="secondary" onClick={onBack} disabled={setupMutation.isPending}>
            Back
          </Button>
          <Button type="submit" loading={setupMutation.isPending}>
            {setupMutation.isPending ? 'Creating account…' : 'Create account'}
          </Button>
        </div>
      </form>
    </section>
  );
}
