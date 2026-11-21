/**
 * Settings › People (owner): who can sign in and with which role, invite
 * links, set-password links, turning sign-in off, removing someone (keeping
 * or deleting their data), as groups (spec §6): People, Invite, Open links.
 * A role saves when changed, after its confirm, its outcome in People's
 * head; Invite, a new set-password link, turning sign-in off and removing
 * are actions. Invites, role changes, resets and removal ask the owner to
 * confirm it is them when the last sign-in is older than five minutes
 * (useStepUpAction). No email is sent: the owner copies the link. The
 * sign-in service's groups follow (SettingsPage renders SignInService
 * after this page).
 */
import { useState } from 'react';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, type InviteLinkResponse, type Role, type UserView } from '@tagave/shared';
import { Banner, Button, HelpToggle, SaveStatus, SegmentedControl, confirmDialog, useSaveFlash } from '../components/ui';
import { InviteGroup, LinkPanel, OpenLinksGroup, PendingLinkRow, PeopleGroup, UserRow, usersListStyles as list } from '../components/users/UsersList';
import { useStepUpAction } from '../components/users/useStepUpAction';
import { useOidcButton } from '../services/oidc';
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
  const service = useOidcButton().data?.name ?? undefined;

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('listener');
  const [made, setMade] = useState<InviteLinkResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // the person whose set-password panel is open, and the link made for them
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [clearFactors, setClearFactors] = useState(false);
  const [resetLink, setResetLink] = useState<InviteLinkResponse | null>(null);
  const roleSaved = useSaveFlash();

  if (isLoading) return <p className={styles.muted}>Loading people…</p>;
  if (error || !data) return <Banner tone="danger">Couldn’t load users.</Banner>;

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

  const onInvite = async () => {
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
    if (!ok) return;
    // a role is a setting: its outcome shows in People's head
    roleSaved.clear();
    try {
      if (await run(`Change ${u.name}'s role`, () => change.mutateAsync({ userId: u.id, role: next }))) roleSaved.saved();
    } catch (err) {
      roleSaved.failed(errorText(err, ''));
    }
  };

  const onToggleDisabled = async (u: UserView) => {
    const turnOff = u.status !== 'disabled';
    if (turnOff) {
      const ok = await confirmDialog({
        title: `Turn off sign-in for ${u.name}?`,
        message: <p>They are signed out everywhere until you turn it back on.</p>,
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
        ? <p>Their account is closed. Their ratings, reviews and listens stay.</p>
        : <p>Their ratings, reviews, listens and saved views are deleted. This cannot be undone.</p>,
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

      <PeopleGroup status={<SaveStatus state={roleSaved.state} detail={roleSaved.detail} />}>
        {data.users.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            busy={busy}
            service={service}
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
                <div className={list.linkHead}>
                  <span className={list.linkTitle}>New set-password link for {u.name}</span>
                  <HelpToggle label="New set-password link">Signs them out everywhere.</HelpToggle>
                </div>
                <div className={list.choice}>
                  <span aria-hidden="true">Remove passkeys and authenticator</span>
                  <SegmentedControl
                    label="Remove passkeys and authenticator"
                    value={clearFactors ? 'on' : 'off'}
                    onChange={(v) => setClearFactors(v === 'on')}
                    options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
                  />
                </div>
                <div className={list.actions}>
                  <Button size="sm" onClick={() => void onMakeReset(u)} loading={reset.isPending}>Make link</Button>
                  <Button size="sm" variant="quiet" onClick={() => setResetFor(null)}>Cancel</Button>
                </div>
              </div>
            ))}
          </UserRow>
        ))}
      </PeopleGroup>

      <InviteGroup
        email={email}
        role={role}
        onEmail={setEmail}
        onRole={setRole}
        onInvite={() => void onInvite()}
        pending={invite.isPending}
        made={made ? (
          <LinkPanel
            title={`Invite link for ${made.invite.email} (${ROLE_LABELS[made.invite.role]})`}
            link={made.link}
            expiresAt={made.invite.expiresAt}
            onDone={() => setMade(null)}
          />
        ) : null}
      />

      {data.invites.length > 0 && (
        <OpenLinksGroup>
          {data.invites.map((i) => (
            <PendingLinkRow key={i.id} invite={i} busy={busy} onRevoke={() => void attempt('Revoke the link', 'Could not revoke the link.', () => revoke.mutateAsync(i.id))} />
          ))}
        </OpenLinksGroup>
      )}

      {dialog}
    </div>
  );
}
