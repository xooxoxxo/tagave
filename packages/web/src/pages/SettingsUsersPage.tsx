/**
 * Settings › Users (owner): who can sign in and with which role, invite
 * links, set-password links, turning sign-in off, removing someone (keeping
 * or deleting their data). Invites, role changes, resets and removal ask the
 * owner to confirm it is them when the last sign-in is older than five
 * minutes (useStepUpAction). No email is sent: the owner copies the link.
 */
import { useState, type FormEvent } from 'react';
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type InviteLinkResponse, type Role, type UserView } from '@tagave/shared';
import { Banner, Button, Select, TextField, confirmDialog } from '../components/ui';
import { LinkPanel, PendingLinkRow, RoleLegend, UserRow, usersListStyles as list } from '../components/users/UsersList';
import { useStepUpAction } from '../components/users/useStepUpAction';
import { useChangeUser, useInviteUser, useRemoveUser, useResetSignIn, useRevokeInvite, useUsers } from '../hooks/useUsers';
import styles from './SettingsSecurityPage.module.css';

const errorText = (err: unknown, fallback: string) => {
  const e = err as { detail?: string; title?: string } | null;
  return e?.detail ?? e?.title ?? fallback;
};

export function SettingsUsersPage() {
  const { data, isLoading, error } = useUsers();
  const invite = useInviteUser();
  const revoke = useRevokeInvite();
  const change = useChangeUser();
  const reset = useResetSignIn();
  const remove = useRemoveUser();
  const { run, dialog } = useStepUpAction();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('listener');
  const [made, setMade] = useState<InviteLinkResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // the person whose set-password panel is open, and the link made for them
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [clearFactors, setClearFactors] = useState(false);
  const [resetLink, setResetLink] = useState<InviteLinkResponse | null>(null);

  if (isLoading) return <p className={styles.muted}>Loading people…</p>;
  if (error || !data) return <Banner tone="danger">Could not load the people on this tagave.</Banner>;

  const busy = invite.isPending || change.isPending || reset.isPending || remove.isPending || revoke.isPending;
  const attempt = async (what: string, fallback: string, fn: () => Promise<unknown>) => {
    setProblem(null);
    try {
      return await run(what, fn);
    } catch (err) {
      setProblem(errorText(err, fallback));
      return undefined;
    }
  };

  const onInvite = async (e: FormEvent) => {
    e.preventDefault();
    const body = { email: email.trim(), role };
    const res = await attempt(`Invite ${body.email}`, 'Could not make the invite link.', () => invite.mutateAsync(body));
    if (res) {
      setMade(res as InviteLinkResponse);
      setEmail('');
    }
  };

  const onRole = async (u: UserView, next: Role) => {
    if (next === u.role) return;
    const ok = await confirmDialog({
      title: `Make ${u.name} ${next === 'owner' ? 'an owner' : next === 'editor' ? 'an editor' : 'a listener'}?`,
      message: <p>{ROLE_DESCRIPTIONS[next]}</p>,
      confirmLabel: `Make ${ROLE_LABELS[next].toLowerCase()}`,
    });
    if (ok) await attempt(`Change ${u.name}'s role`, 'Could not change the role.', () => change.mutateAsync({ userId: u.id, role: next }));
  };

  const onToggleDisabled = async (u: UserView) => {
    const turnOff = u.status !== 'disabled';
    if (turnOff) {
      const ok = await confirmDialog({
        title: `Turn off sign-in for ${u.name}?`,
        message: <p>They are signed out on every device and cannot sign in until you turn it back on. Their ratings, reviews and listens stay.</p>,
        confirmLabel: 'Turn off sign-in',
        tone: 'danger',
      });
      if (!ok) return;
    }
    await attempt(`${turnOff ? 'Turn off' : 'Turn on'} sign-in for ${u.name}`, 'Could not change sign-in.', () => change.mutateAsync({ userId: u.id, disabled: turnOff }));
  };

  const onRemove = async (u: UserView, choice: 'keep' | 'delete') => {
    const ok = await confirmDialog({
      title: choice === 'keep' ? `Remove ${u.name}?` : `Remove ${u.name} and delete their data?`,
      message: choice === 'keep'
        ? <p>Their account is closed for good and their email address is freed. Their ratings, reviews and listens stay in the library's history.</p>
        : <p>Their account and their ratings, reviews, listens and saved views are deleted. This cannot be undone. Albums and tag changes stay.</p>,
      confirmLabel: choice === 'keep' ? 'Remove' : 'Remove and delete',
      tone: 'danger',
    });
    if (ok) await attempt(`Remove ${u.name}`, 'Could not remove them.', () => remove.mutateAsync({ userId: u.id, data: choice }));
  };

  const onMakeReset = async (u: UserView) => {
    const res = await attempt(`New set-password link for ${u.name}`, 'Could not make the link.', () => reset.mutateAsync({ userId: u.id, clearSecondFactors: clearFactors }));
    if (res) setResetLink(res as InviteLinkResponse);
  };

  const openReset = (u: UserView) => {
    setResetFor(u.id);
    setResetLink(null);
    setClearFactors(false);
  };

  return (
    <div className={styles.page}>
      {problem && <Banner tone="danger">{problem}</Banner>}

      <section className={styles.section} aria-labelledby="users-people">
        <h3 id="users-people" className={styles.title}>People</h3>
        <ul className={list.list}>
          {data.users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              busy={busy}
              actions={{
                onRole: (r) => void onRole(u, r),
                onToggleDisabled: () => void onToggleDisabled(u),
                onResetSignIn: () => openReset(u),
                onRemove: (choice) => void onRemove(u, choice),
              }}
            >
              {resetFor === u.id && (resetLink ? (
                <LinkPanel
                  title={`Set-password link for ${u.name}`}
                  link={resetLink.link}
                  expiresAt={resetLink.invite.expiresAt}
                  onDone={() => { setResetFor(null); setResetLink(null); }}
                />
              ) : (
                <div className={list.linkPanel}>
                  <p className={list.linkTitle}>New set-password link for {u.name}</p>
                  <p className={list.hint}>With the link they choose a new password. Every device they are signed in on is signed out.</p>
                  <label className={list.check}>
                    <input type="checkbox" checked={clearFactors} onChange={(e) => setClearFactors(e.target.checked)} />
                    <span>Also remove their passkeys and authenticator app (a lost phone or key)</span>
                  </label>
                  <div className={list.buttons}>
                    <Button size="sm" onClick={() => void onMakeReset(u)} loading={reset.isPending}>Make link</Button>
                    <Button size="sm" variant="quiet" onClick={() => setResetFor(null)}>Cancel</Button>
                  </div>
                </div>
              ))}
            </UserRow>
          ))}
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="users-invite">
        <h3 id="users-invite" className={styles.title}>Invite someone</h3>
        <p className={styles.hint}>tagave makes a link for them to set their name and password. It works once, for 7 days.</p>
        {made ? (
          <LinkPanel
            title={`Invite link for ${made.invite.email} (${ROLE_LABELS[made.invite.role]})`}
            link={made.link}
            expiresAt={made.invite.expiresAt}
            onDone={() => setMade(null)}
          />
        ) : (
          <form className={list.form} onSubmit={(e) => void onInvite(e)}>
            <TextField label="Email address" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
            <div className={list.field}>
              <label htmlFor="invite-role" className={list.fieldLabel}>Role</label>
              <Select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </Select>
            </div>
            <RoleLegend />
            <div>
              <Button type="submit" disabled={!email.trim()} loading={invite.isPending}>Make invite link</Button>
            </div>
          </form>
        )}
      </section>

      {data.invites.length > 0 && (
        <section className={styles.section} aria-labelledby="users-links">
          <h3 id="users-links" className={styles.title}>Open links</h3>
          <ul className={list.list}>
            {data.invites.map((i) => (
              <PendingLinkRow key={i.id} invite={i} busy={busy} onRevoke={() => void attempt('Revoke the link', 'Could not revoke the link.', () => revoke.mutateAsync(i.id))} />
            ))}
          </ul>
        </section>
      )}
      {dialog}
    </div>
  );
}
