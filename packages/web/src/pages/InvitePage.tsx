/**
 * /invite/$token: an invite or set-password link from Settings › Users.
 * An invite asks for a name and a password and makes the account; a
 * set-password link asks for a new password. Either way the person is
 * signed in and, for a new account, offered a passkey or an authenticator
 * app next (the setup wizard's last step, without the setup steps).
 */
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { MIN_PASSWORD_LENGTH, type InviteLookup, type SessionUser } from '@tagave/shared';
import { Banner, Button, LinkButton, TextField } from '../components/ui';
import { useQueryClient } from '@tanstack/react-query';
import { AUTH_QUERY_KEY, signOut } from '../hooks/useAuth';
import { useAcceptInvite, useInviteLookup } from '../hooks/useUsers';
import styles from './SetupPage.module.css';

const A_ROLE: Record<InviteLookup['role'], string> = { owner: 'an owner', editor: 'an editor', listener: 'a listener' };

export interface InviteFormValues {
  name: string;
  password: string;
  confirm: string;
}

export interface InviteFormViewProps {
  link: InviteLookup;
  pending?: boolean;
  serverError?: string | null;
  onSubmit: (values: InviteFormValues) => void;
}

export function validateInvite(link: Pick<InviteLookup, 'purpose'>, v: InviteFormValues): Partial<Record<keyof InviteFormValues, string>> {
  const errors: Partial<Record<keyof InviteFormValues, string>> = {};
  if (link.purpose === 'invite' && !v.name.trim()) errors.name = 'Enter your name.';
  if (v.password.length < MIN_PASSWORD_LENGTH) errors.password = `At least ${MIN_PASSWORD_LENGTH} characters.`;
  else if (v.confirm !== v.password) errors.confirm = 'The two passwords are not the same.';
  return errors;
}

/** The form, without data fetching (Storybook renders it with fixtures). */
export function InviteFormView({ link, pending = false, serverError = null, onSubmit }: InviteFormViewProps) {
  const [values, setValues] = useState<InviteFormValues>({ name: link.name ?? '', password: '', confirm: '' });
  const [errors, setErrors] = useState<ReturnType<typeof validateInvite>>({});
  const [show, setShow] = useState(false);
  const invite = link.purpose === 'invite';
  const set = (k: keyof InviteFormValues) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found = validateInvite(link, values);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(values);
  };
  return (
    <section aria-labelledby="invite-heading" className={styles.section}>
      <h2 id="invite-heading" className={styles.heading}>{invite ? 'Create your account' : 'Choose a new password'}</h2>
      <p className={styles.lead}>
        {invite
          ? <>Invited as {A_ROLE[link.role]}</>
          : <>For {link.email}. Signs you out everywhere.{link.clearSecondFactors ? ' Passkeys and authenticator are removed.' : ''}</>}
      </p>
      <form onSubmit={submit} className={styles.form} noValidate>
        {invite && <TextField label="Email" type="email" value={link.email} readOnly autoComplete="username" />}
        {!invite && <input type="email" hidden readOnly value={link.email} autoComplete="username" />}
        {invite && <TextField label="Name" required autoComplete="name" value={values.name} onChange={set('name')} error={errors.name} disabled={pending} />}
        <div className={styles.passwordField}>
          <TextField
            label={invite ? 'Password' : 'New password'}
            type={show ? 'text' : 'password'}
            required
            autoComplete="new-password"
            value={values.password}
            onChange={set('password')}
            error={errors.password}
            placeholder={`${MIN_PASSWORD_LENGTH}+ characters`}
            disabled={pending}
          />
          <Button variant="quiet" size="sm" type="button" className={styles.togglePassword} onClick={() => setShow((s) => !s)}>
            {show ? 'Hide' : 'Show'}
          </Button>
        </div>
        <TextField label="Repeat password" type={show ? 'text' : 'password'} required autoComplete="new-password" value={values.confirm} onChange={set('confirm')} error={errors.confirm} disabled={pending} />
        {serverError && <Banner tone="danger">{serverError}</Banner>}
        <div className={styles.actions}>
          <Button type="submit" loading={pending}>{invite ? 'Create account' : 'Set password'}</Button>
        </div>
      </form>
    </section>
  );
}

/** The link no longer works. */
export function InviteGoneView() {
  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>This link no longer works</h2>
      <p className={styles.lead}>Ask for a new one.</p>
      <div className={styles.actions}><LinkButton to="/login" variant="secondary">Sign in</LinkButton></div>
    </section>
  );
}

export function InvitePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const navigate = useNavigate();
  // Who is signed in, as App.tsx already asked (a second useMe here would
  // refetch the 401 on every mount, and App's loading screen remounts this).
  const me = useQueryClient().getQueryData<SessionUser>(AUTH_QUERY_KEY);
  // signed in as someone else: sign out and stay on this link
  const [leaving, setLeaving] = useState(false);
  const signOutHere = async () => {
    setLeaving(true);
    try { await signOut(); } finally { window.location.reload(); }
  };
  const lookup = useInviteLookup(token);
  const accept = useAcceptInvite(token);

  const signedIn = me && !accept.isSuccess;
  let body;
  if (lookup.isLoading) body = <p className={styles.muted}>Loading…</p>;
  else if (signedIn) {
    body = (
      <section className={styles.section}>
        <h2 className={styles.heading}>You are signed in</h2>
        <p className={styles.lead}>You are signed in as {me!.email}. To use this link, sign out first.</p>
        <div className={styles.actions}>
          <LinkButton to="/" variant="secondary">Go to Home</LinkButton>
          <Button onClick={() => void signOutHere()} loading={leaving}>Sign out</Button>
        </div>
      </section>
    );
  } else if (lookup.isError || !lookup.data) body = <InviteGoneView />;
  else {
    const link = lookup.data;
    const err = accept.error as { detail?: string; status?: number } | null;
    body = (
      <InviteFormView
        link={link}
        pending={accept.isPending}
        serverError={err ? (err.status === 404 ? 'This link no longer works. Ask for a new one.' : err.detail ?? 'That did not work. Try again.') : null}
        onSubmit={(v) => accept.mutate(
          { password: v.password, ...(link.purpose === 'invite' ? { name: v.name.trim() } : {}) },
          {
            onSuccess: () => {
              const protect = link.purpose === 'invite' || link.clearSecondFactors;
              void navigate(protect ? { to: '/onboarding/protect', search: { from: 'invite' } } : { to: '/' });
            },
          },
        )}
      />
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>tagave</h1>
        {body}
      </div>
    </div>
  );
}
