/**
 * Settings › Account: the signed-in person's name (changed through Better
 * Auth's update-user, which cannot touch the role), their email address and
 * what their role lets them do here.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@tagave/shared';
import { Badge, Banner, Button, TextField } from '../components/ui';
import { AUTH_QUERY_KEY, useMe } from '../hooks/useAuth';
import { authClient } from '../services/authClient';
import styles from './SettingsSecurityPage.module.css';

export function SettingsAccountPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const user = me.data;
  if (!user) return <p className={styles.muted}>Loading…</p>;

  const draft = name ?? user.displayName;
  const dirty = draft.trim() !== user.displayName && draft.trim().length > 0;

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const { error: err } = await authClient().updateUser({ name: draft.trim() });
    setSaving(false);
    if (err) {
      setError(err.message ?? 'Could not save your name.');
      return;
    }
    setName(null);
    setSaved(true);
    await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
  };

  return (
    <div className={styles.page}>
      <section className={styles.section} aria-labelledby="account-name">
        <h3 id="account-name" className={styles.title}>Name</h3>
        <form className={styles.section} onSubmit={(e) => { e.preventDefault(); if (dirty) void save(); }}>
          <TextField label="Name" value={draft} maxLength={255} autoComplete="name" onChange={(e) => { setName(e.target.value); setSaved(false); }} hint="Shown to the owner in Settings › Users." />
          <div>
            <Button type="submit" disabled={!dirty} loading={saving}>Save</Button>
          </div>
          {error && <Banner tone="danger">{error}</Banner>}
          {saved && <p className={styles.muted} role="status">Saved.</p>}
        </form>
      </section>

      <section className={styles.section} aria-labelledby="account-email">
        <h3 id="account-email" className={styles.title}>Email address</h3>
        <p className={styles.hint}>{user.email}</p>
        <p className={styles.muted}>You sign in with this address. Change your password under <Link to="/settings/$section" params={{ section: 'security' }}>Security</Link>.</p>
      </section>

      <section className={styles.section} aria-labelledby="account-role">
        <h3 id="account-role" className={styles.title}>Role</h3>
        <p className={styles.hint}><Badge tone={user.role === 'owner' ? 'accent' : user.role === 'editor' ? 'info' : 'neutral'}>{ROLE_LABELS[user.role]}</Badge> {ROLE_DESCRIPTIONS[user.role]}</p>
        {user.role !== 'owner' && <p className={styles.muted}>The owner of this tagave sets roles.</p>}
      </section>
    </div>
  );
}
