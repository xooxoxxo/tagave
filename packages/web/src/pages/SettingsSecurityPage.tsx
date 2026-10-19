/**
 * Settings › Security: how the account is protected. Sign-in methods and the
 * health line, passkeys and security keys, the authenticator app, backup
 * codes, trusted devices, and the password.
 */
import { useState, type ReactNode } from 'react';
import { Banner, Button, TextField, confirmDialog } from '../components/ui';
import { AuthenticatorSetup } from '../components/AuthenticatorSetup';
import { BackupCodesPanel } from '../components/BackupCodesPanel';
import { useMe } from '../hooks';
import { useForgetDevice, useRefreshSecurity, useSecurity } from '../hooks/useSecurity';
import { authClient } from '../services/authClient';
import { shortDate } from '../utils/time';
import { signInErrorMessage } from './loginErrors';
import { accountHealth, deviceLabel, type SecurityStatus } from './securityModel';
import { PasskeysSection } from './SecurityPasskeys';
import styles from './SettingsSecurityPage.module.css';

function when(iso: string | null): string {
  return iso ? shortDate(iso) : 'unknown';
}

function day(iso: string): string {
  return shortDate(iso, { time: false });
}

function Section({ id, title, children, action }: { id: string; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.head}>
        <h3 id={id} className={styles.title}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SettingsSecurityPage() {
  const { data, isLoading, error } = useSecurity();
  const me = useMe();
  if (isLoading) return <p className={styles.muted}>Loading…</p>;
  if (error || !data) return <Banner tone="danger">Could not load your security settings.</Banner>;
  const email = me.data?.email ?? '';
  return (
    <div className={styles.page}>
      <Overview data={data} />
      <PasskeysSection data={data} />
      <AuthenticatorSection data={data} email={email} />
      {data.twoFactor.enabled && <BackupCodesSection data={data} email={email} />}
      <TrustedDevicesSection data={data} />
      <PasswordSection data={data} />
    </div>
  );
}

function Overview({ data }: { data: SecurityStatus }) {
  const health = accountHealth(data);
  return (
    <Section id="security-methods" title="Sign-in">
      <Banner tone={health.tone}>{health.text}</Banner>

    </Section>
  );
}

function AuthenticatorSection({ data, email }: { data: SecurityStatus; email: string }) {
  const refresh = useRefreshSecurity();
  const [mode, setMode] = useState<'idle' | 'enrol' | 'disable'>('idle');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const disable = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient().twoFactor.disable({ password });
    setPending(false);
    if (error) {
      setError(error.code === 'INVALID_PASSWORD' ? 'That is not your password.' : signInErrorMessage(error));
      return;
    }
    setPassword('');
    setMode('idle');
    await refresh();
  };

  return (
    <Section
      id="security-totp"
      title="Authenticator app"
      action={
        mode === 'idle' &&
        (data.twoFactor.enabled ? (
          <Button variant="quiet-danger" onClick={() => setMode('disable')}>Turn off</Button>
        ) : (
          <Button onClick={() => setMode('enrol')}>Set up</Button>
        ))
      }
    >

      {mode === 'enrol' && (
        <AuthenticatorSetup
          email={email}
          onCancel={() => setMode('idle')}
          onDone={async () => {
            setMode('idle');
            await refresh();
          }}
        />
      )}
      {mode === 'disable' && (
        <form className={styles.form} onSubmit={disable}>
          <p className={styles.hint}>This also forgets trusted devices and backup codes.</p>
          <TextField label="Your password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
          {error && <Banner tone="danger">{error}</Banner>}
          <div className={styles.actions}>
            <Button type="submit" variant="quiet-danger" loading={pending} disabled={!password}>Turn off</Button>
            <Button type="button" variant="quiet" onClick={() => setMode('idle')}>Cancel</Button>
          </div>
        </form>
      )}
    </Section>
  );
}

function BackupCodesSection({ data, email }: { data: SecurityStatus; email: string }) {
  const refresh = useRefreshSecurity();
  const [mode, setMode] = useState<'idle' | 'password' | { codes: string[] }>('idle');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const left = data.twoFactor.backupCodesLeft;

  const regenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { data: res, error } = await authClient().twoFactor.generateBackupCodes({ password });
    setPending(false);
    if (error || !res) {
      setError(error?.code === 'INVALID_PASSWORD' ? 'That is not your password.' : signInErrorMessage(error));
      return;
    }
    setPassword('');
    setMode({ codes: res.backupCodes });
  };

  return (
    <Section
      id="security-backup"
      title="Backup codes"
      action={mode === 'idle' && <Button variant="secondary" onClick={() => setMode('password')}>Make new codes</Button>}
    >
      {left !== null && left > 3 && <p className={styles.hint}>{left} of 10 left</p>}
      {left !== null && left <= 3 && mode === 'idle' && <Banner tone="warning">Only {left} of 10 left</Banner>}
      {mode === 'password' && (
        <form className={styles.form} onSubmit={regenerate}>
          <TextField label="Your password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
          {error && <Banner tone="danger">{error}</Banner>}
          <div className={styles.actions}>
            <Button type="submit" loading={pending} disabled={!password}>Make new codes</Button>
            <Button type="button" variant="quiet" onClick={() => setMode('idle')}>Cancel</Button>
          </div>
        </form>
      )}
      {typeof mode === 'object' && (
        <BackupCodesPanel
          codes={mode.codes}
          email={email}
          onDone={async () => {
            setMode('idle');
            await refresh();
          }}
        />
      )}
    </Section>
  );
}

function TrustedDevicesSection({ data }: { data: SecurityStatus }) {
  const forget = useForgetDevice();
  const onForget = async (id: string, current: boolean) => {
    const ok = await confirmDialog({
      title: current ? 'Forget this device?' : 'Forget that device?',
      message: 'Its next sign-in asks for the authenticator code again.',
      confirmLabel: 'Forget',
      tone: 'danger',
    });
    if (ok) forget.mutate(id);
  };
  return (
    <Section id="security-devices" title="Trusted devices">
      {data.trustedDevices.length === 0 ? (
        <p className={styles.muted}>None</p>
      ) : (
        <ul className={styles.list}>
          {data.trustedDevices.map((d) => (
            <li key={d.id} className={styles.item}>
              <div>
                <strong>{deviceLabel(d.userAgent)}</strong>
                {d.current && <span className={styles.badge}>This device</span>}
                <div className={styles.muted}>
                  {when(d.lastUsedAt)} · until {day(d.expiresAt)}
                  {d.ipAddress ? ` · ${d.ipAddress}` : ''}
                </div>
              </div>
              <Button variant="quiet-danger" size="sm" onClick={() => void onForget(d.id, d.current)} disabled={forget.isPending}>
                Forget
              </Button>
            </li>
          ))}
        </ul>
      )}
      {forget.error && <Banner tone="danger">Could not forget that device.</Banner>}
    </Section>
  );
}

function PasswordSection({ data }: { data: SecurityStatus }) {
  const refresh = useRefreshSecurity();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  const tooShort = next.length > 0 && next.length < 12;
  const mismatch = repeat.length > 0 && repeat !== next;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient().changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: signOutOthers });
    setPending(false);
    if (error) {
      setError(error.code === 'INVALID_PASSWORD' ? 'Your current password is not right.' : signInErrorMessage(error));
      return;
    }
    setCurrent('');
    setNext('');
    setRepeat('');
    setOpen(false);
    setDone(true);
    await refresh();
  };

  return (
    <Section
      id="security-password"
      title="Password"
      action={!open && <Button variant="secondary" onClick={() => { setOpen(true); setDone(false); }}>Change password</Button>}
    >
      {done && <Banner tone="success">Password changed</Banner>}
      {open && (
        <form className={styles.form} onSubmit={submit}>
          <TextField label="Current password" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
          <TextField label="New password" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" hint="At least 12 characters." error={tooShort ? 'Use at least 12 characters.' : undefined} />
          <TextField label="New password again" type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" error={mismatch ? 'The two passwords differ.' : undefined} />
          <label className={styles.check}>
            <input type="checkbox" checked={signOutOthers} onChange={(e) => setSignOutOthers(e.target.checked)} />
            Sign out my other devices
          </label>
          {error && <Banner tone="danger">{error}</Banner>}
          <div className={styles.actions}>
            <Button type="submit" loading={pending} disabled={!current || next.length < 12 || next !== repeat}>Change password</Button>
            <Button type="button" variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </Section>
  );
}
