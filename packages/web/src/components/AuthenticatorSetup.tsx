/**
 * Authenticator-app enrolment: confirm the password, scan the QR code (made
 * in the browser; the secret never goes to a third party) or type the key,
 * prove it with one code, then keep the backup codes. Used by Settings ›
 * Security and the setup wizard's "Protect your account" step.
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Banner, Button, TextField } from './ui';
import { BackupCodesPanel } from './BackupCodesPanel';
import { authClient } from '../services/authClient';
import { signInErrorMessage } from '../pages/loginErrors';
import styles from './AuthenticatorSetup.module.css';

interface Props {
  email: string;
  onDone: () => void;
  onCancel?: () => void;
}

type Step = { at: 'password' } | { at: 'scan'; uri: string; codes: string[] } | { at: 'codes'; codes: string[] };

export function AuthenticatorSetup({ email, onDone, onCancel }: Props) {
  const [step, setStep] = useState<Step>({ at: 'password' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (step.at !== 'scan') return;
    let live = true;
    QRCode.toDataURL(step.uri, { margin: 1, width: 208 }).then((url) => live && setQr(url), () => live && setQr(null));
    return () => {
      live = false;
    };
  }, [step]);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { data, error } = await authClient().twoFactor.enable({ password });
    setPending(false);
    if (error || !data || !('totpURI' in data) || !data.totpURI) {
      setError(error?.code === 'INVALID_PASSWORD' ? 'That is not your password.' : signInErrorMessage(error));
      return;
    }
    setPassword('');
    setStep({ at: 'scan', uri: data.totpURI, codes: data.backupCodes ?? [] });
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step.at !== 'scan') return;
    setPending(true);
    setError(null);
    const { error } = await authClient().twoFactor.verifyTotp({ code });
    setPending(false);
    if (error) {
      setError(signInErrorMessage(error));
      return;
    }
    setStep({ at: 'codes', codes: step.codes });
  };

  if (step.at === 'codes') return <BackupCodesPanel codes={step.codes} email={email} onDone={onDone} />;

  if (step.at === 'scan') {
    const secret = new URL(step.uri).searchParams.get('secret') ?? '';
    return (
      <form className={styles.form} onSubmit={verify}>
        <p className={styles.hint}>Scan this with your authenticator app (1Password, Aegis, Google Authenticator, Raivo...), or type the key.</p>
        <div className={styles.scan}>
          {qr ? <img src={qr} width={208} height={208} alt="QR code for your authenticator app" className={styles.qr} /> : <div className={styles.qr} />}
          <div className={styles.key}>
            <span className={styles.label}>Key</span>
            <code className={styles.secret} aria-label="Authenticator key">{secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          </div>
        </div>
        <TextField
          label="Code from the app"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          autoFocus
        />
        {error && <Banner tone="danger">{error}</Banner>}
        <div className={styles.actions}>
          <Button type="submit" loading={pending} disabled={code.length !== 6}>Turn on</Button>
          {onCancel && <Button type="button" variant="quiet" onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    );
  }

  return (
    <form className={styles.form} onSubmit={start}>
      <TextField
        label="Your password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        autoFocus
      />
      {error && <Banner tone="danger">{error}</Banner>}
      <div className={styles.actions}>
        <Button type="submit" loading={pending} disabled={!password}>Continue</Button>
        {onCancel && <Button type="button" variant="quiet" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}
