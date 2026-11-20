/**
 * Your settings › Account › Passkeys and security keys: a group with a row per
 * key (name; model, synced or device-bound, added), add a passkey or a
 * security key under it, rename, remove.
 */
import { useState } from 'react';
import { Banner, Button, Input, SaveStatus, SettingsGroup, SettingsRow, confirmDialog } from '../components/ui';
import { useRefreshSecurity } from '../hooks/useSecurity';
import { addPasskey, deletePasskey, renamePasskey, type PasskeyKind } from '../services/passkeys';
import { signInErrorMessage } from './loginErrors';
import { accountHealth, passkeyKind, passkeyLabel, passkeyProblem, type PasskeyView, type SecurityStatus } from './securityModel';
import { shortDate } from '../utils/time';
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
  const problem = passkeyProblem(data.config, typeof window === 'undefined' ? data.config.publicUrl : window.location.origin);
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

  const saveName = async (id: string) => {
    if (!name.trim()) return;
    const res = await renamePasskey(id, name.trim());
    if (!res.ok) {
      setError(signInErrorMessage(res.error));
      return;
    }
    setRenaming(null);
    await refresh();
  };

  return (
    <SettingsGroup
      title="Passkeys and security keys"
      status={error ? <SaveStatus state="failed" detail={error} /> : null}
      after={<>
        {problem && <Banner tone="warning">{problem}</Banner>}
        <AddPasskeyButtons onAdded={refresh} disabled={Boolean(problem)} />
      </>}
    >
      {data.passkeys.length === 0 && <SettingsRow as="div" label="Passkeys" value={<span className={styles.value}>None</span>} />}
      {data.passkeys.map((p) => renaming === p.id ? (
        // a row, not a form (a form between rows would break their dividers): Enter saves
        <SettingsRow key={p.id} as="div" label="Name">
          <span className={styles.actions}>
            <Input
              dense className={styles.field} aria-label="Name" value={name} autoFocus maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveName(p.id); } }}
            />
            <Button size="sm" disabled={!name.trim()} onClick={() => void saveName(p.id)}>Save</Button>
            <Button size="sm" variant="quiet" onClick={() => setRenaming(null)}>Cancel</Button>
          </span>
        </SettingsRow>
      ) : (
        <SettingsRow
          key={p.id}
          as="div"
          label={passkeyLabel(p)}
          value={<span className={styles.value}>{passkeyKind(p)}{p.createdAt ? ` · ${shortDate(p.createdAt, { time: false })}` : ''}</span>}
        >
          <span className={styles.actions}>
            <Button variant="quiet" size="sm" onClick={() => { setRenaming(p.id); setName(passkeyLabel(p)); }}>Rename</Button>
            <Button variant="quiet-danger" size="sm" onClick={() => void remove(p)}>Remove</Button>
          </span>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
