/**
 * Your settings › Account: how the account is protected, as groups after the
 * Account group (spec §6). Sign-in (the health line), passkeys and security
 * keys, the authenticator app, backup codes, trusted devices, and the
 * password. Each subject is a SettingsGroup of rows; a flow (set up the
 * authenticator, confirm your password) opens under its group's rows.
 */
import { useState } from 'react';
import { Badge, Banner, Button, Input, SaveStatus, SegmentedControl, SettingsGroup, SettingsRow, SettingsSave, TextField, confirmDialog, useSaveFlash } from '../components/ui';
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
  return iso ? shortDate(iso) : 'Unknown';
}

function day(iso: string): string {
  return shortDate(iso, { time: false });
}

export function SettingsSecurityPage() {
  const { data, isLoading, error } = useSecurity();
  const me = useMe();
  if (isLoading) return <p className={styles.muted}>Loading…</p>;
  if (error || !data) return <Banner tone="danger">Could not load your security settings.</Banner>;
  return <SecurityView data={data} email={me.data?.email ?? ''} />;
}

/** The groups for a loaded status (tests and stories render it with fixtures). */
export function SecurityView({ data, email }: { data: SecurityStatus; email: string }) {
  return (
    <div className={styles.page}>
      <Overview data={data} />
      <PasskeysSection data={data} />
      <AuthenticatorSection data={data} email={email} />
      {data.twoFactor.enabled && <BackupCodesSection data={data} email={email} />}
      <TrustedDevicesSection data={data} />
      <PasswordSection />
    </div>
  );
}

function Overview({ data }: { data: SecurityStatus }) {
  const health = accountHealth(data);
  return (
    <SettingsGroup title="Sign-in">
      <SettingsRow as="div" label="Second factors" value={<Badge tone={health.tone}>{health.text}</Badge>} />
    </SettingsGroup>
  );
}

function AuthenticatorSection({ data, email }: { data: SecurityStatus; email: string }) {
  const refresh = useRefreshSecurity();
  const [mode, setMode] = useState<'idle' | 'enrol' | 'disable'>('idle');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const on = data.twoFactor.enabled;

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

  const flow = mode === 'enrol' ? (
    <AuthenticatorSetup
      email={email}
      onCancel={() => setMode('idle')}
      onDone={async () => {
        setMode('idle');
        await refresh();
      }}
    />
  ) : mode === 'disable' ? (
    <form className={styles.form} onSubmit={disable}>
      <TextField label="Your password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
      {error && <Banner tone="danger">{error}</Banner>}
      <div className={styles.actions}>
        <Button type="submit" variant="quiet-danger" loading={pending} disabled={!password}>Turn off</Button>
        <Button type="button" variant="quiet" onClick={() => setMode('idle')}>Cancel</Button>
      </div>
    </form>
  ) : null;

  return (
    <SettingsGroup title="Authenticator app" after={flow}>
      <SettingsRow
        as="div"
        label="Authenticator app"
        help={on ? 'Turning it off also forgets trusted devices and backup codes.' : undefined}
        value={<span className={styles.value}>{on ? 'On' : 'Not set'}</span>}
      >
        {mode === 'idle' && (on
          ? <Button size="sm" variant="quiet-danger" onClick={() => setMode('disable')}>Turn off</Button>
          : <Button size="sm" onClick={() => setMode('enrol')}>Set up</Button>)}
      </SettingsRow>
    </SettingsGroup>
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

  const flow = mode === 'password' ? (
    <form className={styles.form} onSubmit={regenerate}>
      <TextField label="Your password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
      {error && <Banner tone="danger">{error}</Banner>}
      <div className={styles.actions}>
        <Button type="submit" loading={pending} disabled={!password}>Make new codes</Button>
        <Button type="button" variant="quiet" onClick={() => setMode('idle')}>Cancel</Button>
      </div>
    </form>
  ) : typeof mode === 'object' ? (
    <BackupCodesPanel
      codes={mode.codes}
      email={email}
      onDone={async () => {
        setMode('idle');
        await refresh();
      }}
    />
  ) : null;

  const count = left === null ? 'Unknown' : `${left} of 10 left`;
  return (
    <SettingsGroup title="Backup codes" after={flow}>
      <SettingsRow
        as="div"
        label="Backup codes"
        value={left !== null && left <= 3 ? <Badge tone="warning">{count}</Badge> : <span className={styles.value}>{count}</span>}
      >
        {mode === 'idle' && <Button size="sm" variant="secondary" onClick={() => setMode('password')}>Make new codes</Button>}
      </SettingsRow>
    </SettingsGroup>
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
    <SettingsGroup title="Trusted devices" status={forget.error ? <SaveStatus state="failed" detail="Could not forget that device." /> : null}>
      {data.trustedDevices.length === 0
        ? <SettingsRow as="div" label="Trusted devices" value={<span className={styles.value}>None</span>} />
        : data.trustedDevices.map((d) => (
          <SettingsRow
            key={d.id}
            as="div"
            label={deviceLabel(d.userAgent)}
            value={<span className={styles.value}>
              {d.current && <Badge tone="neutral">This device</Badge>}{' '}
              {when(d.lastUsedAt)} · until {day(d.expiresAt)}{d.ipAddress ? ` · ${d.ipAddress}` : ''}
            </span>}
          >
            <Button variant="quiet-danger" size="sm" onClick={() => void onForget(d.id, d.current)} disabled={forget.isPending}>Forget</Button>
          </SettingsRow>
        ))}
    </SettingsGroup>
  );
}

/**
 * Current, new, new again and Sign out other devices; one action, Change
 * password. Sign out other devices is part of that action, not an instant
 * choice: it means nothing until the password changes.
 */
function PasswordSection() {
  const refresh = useRefreshSecurity();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [pending, setPending] = useState(false);
  const flash = useSaveFlash();

  const tooShort = next.length > 0 && next.length < 12;
  const mismatch = repeat.length > 0 && repeat !== next;
  const ready = !!current && next.length >= 12 && next === repeat;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    flash.clear();
    const { error } = await authClient().changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: signOutOthers });
    setPending(false);
    if (error) {
      flash.failed(error.code === 'INVALID_PASSWORD' ? 'Your current password is not right.' : signInErrorMessage(error));
      return;
    }
    setCurrent('');
    setNext('');
    setRepeat('');
    flash.saved();
    await refresh();
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <SettingsGroup
        title="Password"
        after={<SettingsSave type="submit" label="Change password" dirty={ready} pending={pending} onSave={() => undefined} state={flash.state} detail={flash.detail} />}
      >
        <SettingsRow label="Current password">
          <Input dense className={styles.field} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </SettingsRow>
        <SettingsRow label="New password" help="At least 12 characters">
          <Input dense className={styles.field} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" aria-invalid={tooShort || undefined} />
          {tooShort && <span className={styles.fieldError}>Too short</span>}
        </SettingsRow>
        <SettingsRow label="New password again">
          <Input dense className={styles.field} type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" aria-invalid={mismatch || undefined} />
          {mismatch && <span className={styles.fieldError}>Not the same</span>}
        </SettingsRow>
        <SettingsRow as="div" label="Sign out other devices">
          <SegmentedControl
            label="Sign out other devices"
            value={signOutOthers ? 'on' : 'off'}
            onChange={(v) => setSignOutOthers(v === 'on')}
            options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
          />
        </SettingsRow>
      </SettingsGroup>
    </form>
  );
}
