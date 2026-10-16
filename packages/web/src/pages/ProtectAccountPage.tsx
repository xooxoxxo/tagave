/**
 * Setup wizard, last step (skippable): protect the new account with a
 * passkey or security key, or an authenticator app. Skipping leaves the
 * warning in Settings › Security.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Banner, Button, Card } from '../components/ui';
import { SetupSteps } from '../components/SetupSteps';
import { AuthenticatorSetup } from '../components/AuthenticatorSetup';
import { useMe } from '../hooks';
import { useRefreshSecurity, useSecurity } from '../hooks/useSecurity';
import { AddPasskeyButtons } from './SecurityPasskeys';
import { accountHealth, passkeyProblem } from './securityModel';
import styles from './OnboardingPage.module.css';

export function ProtectAccountPage() {
  const navigate = useNavigate();
  // after an invite: the same step, without the owner's setup steps
  const fromInvite = (useSearch({ strict: false }) as { from?: string }).from === 'invite';
  const me = useMe();
  const { data, isLoading, error } = useSecurity();
  const refresh = useRefreshSecurity();
  const [authenticator, setAuthenticator] = useState(false);
  const [started, setStarted] = useState(false);

  const factors = data ? accountHealth(data).factors : 0;

  // An account that is already protected has nothing to do here.
  useEffect(() => {
    if (data && factors > 0 && !started) navigate({ to: '/' });
  }, [data, factors, started, navigate]);

  if (isLoading) return <div className={styles.container}><p>Loading…</p></div>;

  const problem = data ? passkeyProblem(data.config, window.location.origin) : null;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>Protect your account</h1>
        {!fromInvite && <SetupSteps current="Protect your account" />}
      </header>

      {error && <Banner tone="danger">Could not load your sign-in settings. You can do this later under Settings › Security.</Banner>}

      <Card title="Add a second factor">
        <p>
          With a second factor, a leaked password is not enough to get into tagave, and sensitive actions (deleting a backup,
          changing provider tokens) ask for it.
        </p>
        {data && (
          <p>
            tagave is set up for <code>{data.config.publicUrl}</code> (PUBLIC_URL). Passkeys made now work only at that
            address.
          </p>
        )}
        {problem && <Banner tone="warning">{problem}</Banner>}
        {factors > 0 && <Banner tone="success">Done: your account has {factors === 1 ? 'a second factor' : `${factors} second factors`}.</Banner>}

        <h3>Passkey or security key</h3>
        <AddPasskeyButtons
          disabled={Boolean(problem)}
          onAdded={async () => {
            setStarted(true);
            await refresh();
          }}
        />

        <h3>Authenticator app</h3>
        {data?.twoFactor.enabled ? (
          <p>On.</p>
        ) : authenticator ? (
          <AuthenticatorSetup
            email={me.data?.email ?? ''}
            onCancel={() => setAuthenticator(false)}
            onDone={async () => {
              setAuthenticator(false);
              setStarted(true);
              await refresh();
            }}
          />
        ) : (
          <Button variant="secondary" onClick={() => { setStarted(true); setAuthenticator(true); }}>Set up an authenticator app</Button>
        )}
      </Card>

      <footer className={styles.footer}>
        <Button onClick={() => navigate({ to: '/' })} variant={factors > 0 ? 'primary' : 'secondary'}>
          {factors > 0 ? (fromInvite ? 'Go to Home' : 'Go to my library') : 'Skip for now'}
        </Button>
      </footer>
      {factors === 0 && (
        <p>
          You can do this any time under <Link to="/settings/$section" params={{ section: 'security' }}>Settings › Security</Link>.
        </p>
      )}
    </div>
  );
}
