/**
 * Settings › Security › Passkeys and security keys: the list (name, model,
 * synced or device-bound, added), add a passkey or a security key, rename,
 * remove.
 */
import { useState } from 'react';
import { Banner, Button, TextField, confirmDialog } from '../components/ui';
import { useRefreshSecurity } from '../hooks/useSecurity';
import { addPasskey, deletePasskey, renamePasskey, type PasskeyKind } from '../services/passkeys';
import { signInErrorMessage } from './loginErrors';
import { accountHealth, passkeyKind, passkeyLabel, passkeyProblem, type PasskeyView, type SecurityStatus } from './securityModel';
import styles from './SettingsSecurityPage.module.css';

export function AddPasskeyButtons({ onAdded, disabled }: { onAdded: () => void | Promise<void>; disabled?: boolean }) {
  const [pending, setPending] = useState<PasskeyKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async (kind: PasskeyKind) => {
    setPending(kind);
    setError(null);
    const res = await addPasskey(kind);
    setPending(null);
    if (!res.ok) {
      setError(signInErrorMessage(res.error));
      return;
    }
    await onAdded();
  };

  return (
    <div className={styles.section}>
      <div className={styles.actions}>
        <Button onClick={() => void add('passkey')} loading={pending === 'passkey'} disabled={disabled || pending !== null}>
          Add passkey
        </Button>
        <Button variant="secondary" onClick={() => void add('security-key')} loading={pending === 'security-key'} disabled={disabled || pending !== null}>
          Add security key
        </Button>
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
    </div>
  );
}

export function PasskeysSection({ data }: { data: SecurityStatus }) {
  const refresh = useRefreshSecurity();
  const problem = passkeyProblem(data.config, window.location.origin);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const remove = async (p: PasskeyView) => {
    const lastFactor = accountHealth(data).factors === 1;
    const ok = await confirmDialog({
      title: `Remove ${passkeyLabel(p)}?`,
      message: lastFactor
        ? 'Your password alone will sign you in.'
        : 'It can no longer sign you in.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await deletePasskey(p.id);
    if (!res.ok) setError(signInErrorMessage(res.error));
    await refresh();
  };

  const saveName = async (e: React.FormEvent, id: string) => {
    e.preventDefault();
    const res = await renamePasskey(id, name.trim());
    if (!res.ok) {
      setError(signInErrorMessage(res.error));
      return;
    }
    setRenaming(null);
    await refresh();
  };

  return (
    <section className={styles.section} aria-labelledby="security-passkeys">
      <div className={styles.head}>
        <h3 id="security-passkeys" className={styles.title}>Passkeys and security keys</h3>
      </div>

      {problem && <Banner tone="warning">{problem}</Banner>}
      {data.passkeys.length > 0 && (
        <ul className={styles.list}>
          {data.passkeys.map((p) => (
            <li key={p.id} className={styles.item}>
              {renaming === p.id ? (
                <form className={styles.form} onSubmit={(e) => void saveName(e, p.id)}>
                  <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
                  <div className={styles.actions}>
                    <Button type="submit" size="sm" disabled={!name.trim()}>Save</Button>
                    <Button type="button" size="sm" variant="quiet" onClick={() => setRenaming(null)}>Cancel</Button>
                  </div>
                </form>
              ) : (
                <>
                  <div>
                    <strong>{passkeyLabel(p)}</strong>
                    <div className={styles.muted}>
                      {passkeyKind(p)}
                      {p.createdAt ? ` · added ${new Date(p.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : ''}
                    </div>
                  </div>
                  <div className={styles.actions}>
                    <Button variant="quiet" size="sm" onClick={() => { setRenaming(p.id); setName(passkeyLabel(p)); }}>Rename</Button>
                    <Button variant="quiet-danger" size="sm" onClick={() => void remove(p)}>Remove</Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <Banner tone="danger">{error}</Banner>}
      <AddPasskeyButtons onAdded={refresh} disabled={Boolean(problem)} />
    </section>
  );
}
