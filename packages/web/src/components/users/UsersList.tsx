/**
 * Settings › Users, the parts that only draw: a person's row (name, email,
 * role, how they sign in, when they were last here, the owner's controls),
 * a pending link's row, and the one-time link panel. SettingsUsersPage
 * wires them to the API; the stories render them with fixtures.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type InviteView, type Role, type UserView } from '@tagave/shared';
import { Badge, Button, Input, Menu, Select, showToast, type BadgeTone, type MenuItem } from '../ui';
import styles from './UsersList.module.css';

const ROLE_TONE: Record<Role, BadgeTone> = { owner: 'accent', editor: 'info', listener: 'neutral' };

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** "Last here 3 Oct 2026", or never. */
export function lastSeenText(iso: string | null): string {
  return iso ? `Last here ${day(iso)}` : 'Never signed in';
}

/** How the person signs in, in a few words. */
export function signInText(u: Pick<UserView, 'twoFactor' | 'passkeys'>): string {
  const parts: string[] = [];
  if (u.passkeys > 0) parts.push(u.passkeys === 1 ? '1 passkey' : `${u.passkeys} passkeys`);
  if (u.twoFactor) parts.push('authenticator app');
  return parts.length ? `Password, ${parts.join(' and ')}` : 'Password only';
}

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={ROLE_TONE[role]}>{ROLE_LABELS[role]}</Badge>;
}

export interface UserRowActions {
  onRole: (role: Role) => void;
  onToggleDisabled: () => void;
  onResetSignIn: () => void;
  onRemove: (data: 'keep' | 'delete') => void;
}

export interface UserRowProps {
  user: UserView;
  actions: UserRowActions;
  busy?: boolean;
  /** Under the row: the set-password panel, a link, an error. */
  children?: ReactNode;
}

export function UserRow({ user, actions, busy = false, children }: UserRowProps) {
  const selectId = useId();
  const removed = user.status === 'removed';
  const menu: MenuItem[] = removed
    ? [{ key: 'delete', label: 'Delete their data', hint: 'Ratings, reviews and listens', tone: 'danger', disabled: busy, onSelect: () => actions.onRemove('delete') }]
    : [
        { key: 'reset', label: 'New set-password link', hint: 'For a forgotten password or a lost device', disabled: busy || user.status === 'disabled', onSelect: actions.onResetSignIn },
        user.status === 'disabled'
          ? { key: 'enable', label: 'Turn sign-in back on', disabled: busy, onSelect: actions.onToggleDisabled }
          : { key: 'disable', label: 'Turn off sign-in', hint: 'Signs them out everywhere; reversible', disabled: busy, onSelect: actions.onToggleDisabled },
        { key: 'remove-keep', label: 'Remove, keep their data', hint: 'Their ratings, reviews and listens stay', tone: 'danger', separated: true, disabled: busy, onSelect: () => actions.onRemove('keep') },
        { key: 'remove-delete', label: 'Remove and delete their data', tone: 'danger', disabled: busy, onSelect: () => actions.onRemove('delete') },
      ];
  return (
    <li className={styles.row} data-status={user.status}>
      <div className={styles.main}>
        <div className={styles.name}>
          <span dir="auto">{user.name}</span>
          {user.isSelf && <span className={styles.self}>(you)</span>}
          {user.status === 'disabled' && <Badge tone="warning">Sign-in off</Badge>}
          {removed && <Badge tone="neutral">Removed</Badge>}
        </div>
        {!removed && <div className={styles.email}>{user.email}</div>}
        <div className={styles.meta}>
          {removed ? 'Account closed; their data is kept' : <>{signInText(user)} · {lastSeenText(user.lastSeenAt)}</>}
        </div>
      </div>
      <div className={styles.controls}>
        {user.isSelf || removed ? (
          <RoleBadge role={user.role} />
        ) : (
          <>
            <label htmlFor={selectId} className="visually-hidden">Role for {user.name}</label>
            <Select id={selectId} dense value={user.role} disabled={busy} onChange={(e) => actions.onRole(e.target.value as Role)} className={styles.roleSelect}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </Select>
          </>
        )}
        {!user.isSelf && <Menu label={`More for ${user.name}`} items={menu} />}
      </div>
      {children && <div className={styles.under}>{children}</div>}
    </li>
  );
}

export function PendingLinkRow({ invite, onRevoke, busy = false }: { invite: InviteView; onRevoke: () => void; busy?: boolean }) {
  return (
    <li className={styles.row}>
      <div className={styles.main}>
        <div className={styles.name}>
          <span>{invite.email}</span>
          {invite.purpose === 'invite' ? <RoleBadge role={invite.role} /> : <Badge tone="neutral">Set-password link</Badge>}
        </div>
        <div className={styles.meta}>
          {invite.expired ? `Expired ${day(invite.expiresAt)}` : `Works until ${day(invite.expiresAt)}`}
          {invite.createdBy ? ` · made by ${invite.createdBy}` : ''}
        </div>
      </div>
      <div className={styles.controls}>
        {!invite.expired && <Button variant="quiet-danger" size="sm" onClick={onRevoke} disabled={busy}>Revoke</Button>}
      </div>
    </li>
  );
}

/** The one-time link, shown once right after it is made. */
export function LinkPanel({ title, link, expiresAt, onDone }: { title: ReactNode; link: string; expiresAt: string; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      showToast({ message: 'Link copied' });
    } catch {
      // no clipboard permission (plain http): select it for a manual copy
      input.current?.select();
    }
  };
  return (
    <div className={styles.linkPanel} role="status">
      <p className={styles.linkTitle}>{title}</p>
      <div className={styles.linkRow}>
        <Input ref={input} dense readOnly value={link} aria-label="One-time link" onFocus={(e) => e.currentTarget.select()} className={styles.linkInput} />
        <Button size="sm" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</Button>
      </div>
      <p className={styles.hint}>
        Send it to them yourself, by message or email. It works once, until {day(expiresAt)}, and is not shown again.
      </p>
      <div><Button variant="quiet" size="sm" onClick={onDone}>Done</Button></div>
    </div>
  );
}

/** One line per role, under the invite form. */
export function RoleLegend() {
  return (
    <dl className={styles.legend}>
      {ROLES.map((r) => (
        <div key={r}><dt>{ROLE_LABELS[r]}</dt><dd>{ROLE_DESCRIPTIONS[r]}</dd></div>
      ))}
    </dl>
  );
}

export const usersListStyles = styles;
