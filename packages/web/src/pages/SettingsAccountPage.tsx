/**
 * Your settings › Account: the signed-in person's name (changed through Better
 * Auth's update-user, which cannot touch the role), their email address and
 * their role, then their link to the login service. One group: Name is typed
 * and saves with the group's one Save; Email and Role are values.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ROLE_LABELS, type Role } from '@tagave/shared';
import { Badge, Input, SettingsGroup, SettingsRow, SettingsSave, useSaveFlash, type SaveState } from '../components/ui';
import { AUTH_QUERY_KEY, useMe } from '../hooks/useAuth';
import { authClient } from '../services/authClient';
import { OidcLinkSection } from '../components/users/OidcLinkSection';
import styles from './SettingsSecurityPage.module.css';

export interface AccountViewProps {
  /** The saved name. */
  name: string;
  email: string;
  role: Role;
  /** The Name field as typed. */
  draft: string;
  onDraft: (name: string) => void;
  onSave: () => void;
  pending: boolean;
  state: SaveState;
  detail: string | null;
}

/** A new name, not blank. */
export const nameChanged = (name: string, draft: string): boolean => draft.trim() !== name && draft.trim().length > 0;

/** The Account group, without data fetching (stories and tests). */
export function AccountView({ name, email, role, draft, onDraft, onSave, pending, state, detail }: AccountViewProps) {
  const dirty = nameChanged(name, draft);
  return (
    // Enter in Name submits only while there is a new name
    <form onSubmit={(e) => { e.preventDefault(); if (dirty && !pending) onSave(); }}>
      <SettingsGroup title="Account" after={<SettingsSave type="submit" dirty={dirty} pending={pending} onSave={onSave} state={state} detail={detail} />}>
        <SettingsRow label="Name">
          <Input dense className={styles.field} value={draft} maxLength={255} autoComplete="name" onChange={(e) => onDraft(e.target.value)} />
        </SettingsRow>
        <SettingsRow as="div" label="Email" value={<span className={styles.value}>{email}</span>} />
        <SettingsRow as="div" label="Role" value={<Badge tone={role === 'owner' ? 'accent' : role === 'editor' ? 'info' : 'neutral'}>{ROLE_LABELS[role]}</Badge>} />
      </SettingsGroup>
    </form>
  );
}

export function SettingsAccountPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const flash = useSaveFlash();
  const user = me.data;
  if (!user) return <p className={styles.muted}>Loading…</p>;

  const draft = name ?? user.displayName;

  const save = async () => {
    setSaving(true);
    flash.clear();
    const { error: err } = await authClient().updateUser({ name: draft.trim() });
    setSaving(false);
    if (err) {
      // the draft stays, so a second try needs no retyping
      flash.failed(err.message ?? null);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    setName(null);
    flash.saved();
  };

  return (
    <div className={styles.page}>
      <AccountView
        name={user.displayName}
        email={user.email}
        role={user.role}
        draft={draft}
        onDraft={(next) => { setName(next); if (flash.state) flash.clear(); }}
        onSave={() => void save()}
        pending={saving}
        state={flash.state}
        detail={flash.detail}
      />
      <OidcLinkSection />
    </div>
  );
}
