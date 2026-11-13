/**
 * Settings › Users › Sign-in service (owner): your own login service
 * (OpenID Connect: Zitadel, Authentik, Authelia, Keycloak, Pocket ID).
 * The client secret is sent, never shown: the field says only whether one
 * is set. Saving asks for a fresh confirmation (useStepUpAction).
 */
import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OidcSettingsRequest, OidcSettingsResponse, OidcTestResult } from '@tagave/shared';
import { Badge, Banner, Button, Input, SegmentedControl, TextField, confirmDialog, showToast } from '../ui';
import { api } from '../../services/api';
import { OIDC_LINK_KEY, OIDC_PUBLIC_KEY, OIDC_SETTINGS_KEY, testOidcIssuer } from '../../services/oidc';
import { USERS_KEY } from '../../hooks/useUsers';
import { useStepUpAction } from './useStepUpAction';
import styles from './UsersList.module.css';

export interface SignInServiceDraft {
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  enabled: boolean;
  joinEnabled: boolean;
  joinGroup: string;
}

export function draftFrom(view: OidcSettingsResponse): SignInServiceDraft {
  const s = view.settings;
  return {
    name: s?.name ?? '',
    issuer: s?.issuer ?? '',
    clientId: s?.clientId ?? '',
    clientSecret: '',
    enabled: s?.enabled ?? true,
    joinEnabled: s?.joinEnabled ?? false,
    joinGroup: s?.joinGroup ?? '',
  };
}

/** The request for a draft: an empty secret field keeps the stored secret. */
export function requestFrom(d: SignInServiceDraft): OidcSettingsRequest {
  return {
    name: d.name.trim(),
    issuer: d.issuer.trim(),
    clientId: d.clientId.trim(),
    ...(d.clientSecret ? { clientSecret: d.clientSecret } : {}),
    enabled: d.enabled,
    joinEnabled: d.joinEnabled,
    joinGroup: d.joinEnabled && d.joinGroup.trim() ? d.joinGroup.trim() : null,
  };
}

export type ServiceState = 'active' | 'unreachable' | 'off' | 'none';

export function serviceState(view: OidcSettingsResponse): ServiceState {
  if (!view.settings) return 'none';
  if (!view.settings.enabled) return 'off';
  return view.active ? 'active' : 'unreachable';
}

const STATE_BADGE: Record<Exclude<ServiceState, 'none'>, { tone: 'success' | 'warning' | 'neutral'; label: string }> = {
  active: { tone: 'success', label: 'On' },
  unreachable: { tone: 'warning', label: 'Not reachable' },
  off: { tone: 'neutral', label: 'Off' },
};

const ON_OFF = [{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }];

export interface SignInServiceFormProps {
  view: OidcSettingsResponse;
  draft: SignInServiceDraft;
  onChange: (d: SignInServiceDraft) => void;
  onTest: () => void;
  onSave: () => void;
  testing?: boolean;
  saving?: boolean;
  tested?: OidcTestResult | null;
  error?: string | null;
  /** The section heading's class (Settings' section rhythm). */
  headingClassName?: string | undefined;
}

/** The form, without data fetching (Storybook renders it with fixtures). */
export function SignInServiceForm({ view, draft, onChange, onTest, onSave, testing = false, saving = false, tested = null, error = null, headingClassName }: SignInServiceFormProps) {
  const redirect = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const state = serviceState(view);
  const set = <K extends keyof SignInServiceDraft>(k: K, v: SignInServiceDraft[K]) => onChange({ ...draft, [k]: v });
  const ready = draft.name.trim() && draft.issuer.trim() && draft.clientId.trim();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.redirectUri);
      setCopied(true);
      showToast({ message: 'Redirect URI copied' });
    } catch {
      redirect.current?.select();
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) onSave();
  };
  return (
    <section className={styles.serviceSection} aria-labelledby="users-sign-in-service">
      <div className={[styles.titleRow, headingClassName].filter(Boolean).join(' ')}>
        <h2 id="users-sign-in-service">Sign-in service</h2>
        {state !== 'none' && <Badge tone={STATE_BADGE[state].tone}>{STATE_BADGE[state].label}</Badge>}
      </div>
      {view.secretUnreadable && <Banner tone="warning">Enter the client secret again.</Banner>}
      <form className={styles.form} onSubmit={submit}>
        <TextField label="Name" required value={draft.name} maxLength={60} placeholder="Zitadel" autoComplete="off" onChange={(e) => set('name', e.target.value)} />
        <TextField label="Issuer" required type="url" value={draft.issuer} placeholder="https://auth.example.com" autoComplete="off" spellCheck={false} onChange={(e) => set('issuer', e.target.value)} />
        <TextField label="Client ID" required value={draft.clientId} autoComplete="off" spellCheck={false} onChange={(e) => set('clientId', e.target.value)} />
        <TextField
          label="Client secret"
          type="password"
          value={draft.clientSecret}
          placeholder={view.settings?.secretSet ? 'Set' : 'Not set'}
          autoComplete="new-password"
          onChange={(e) => set('clientSecret', e.target.value)}
        />
        <div className={styles.field}>
          <label htmlFor="oidc-redirect" className={styles.fieldLabel}>Redirect URI</label>
          <div className={styles.linkRow}>
            <Input id="oidc-redirect" ref={redirect} dense readOnly value={view.redirectUri} onFocus={(e) => e.currentTarget.select()} className={styles.linkInput} />
            <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
          </div>
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel} aria-hidden="true">Sign-in button</span>
          <SegmentedControl label="Sign-in button" value={draft.enabled ? 'on' : 'off'} onChange={(v) => set('enabled', v === 'on')} options={ON_OFF} />
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel} aria-hidden="true">Anyone can join</span>
          <SegmentedControl label="Anyone can join" value={draft.joinEnabled ? 'on' : 'off'} onChange={(v) => set('joinEnabled', v === 'on')} options={ON_OFF} />
        </div>
        {draft.joinEnabled && (
          <TextField label="Group" value={draft.joinGroup} maxLength={255} placeholder="Any" autoComplete="off" spellCheck={false} onChange={(e) => set('joinGroup', e.target.value)} />
        )}
        {tested && <p className={styles.hint} role="status">Found {tested.issuer}</p>}
        {error && <Banner tone="danger">{error}</Banner>}
        <div className={styles.buttons}>
          <Button type="button" variant="secondary" onClick={onTest} loading={testing} disabled={!draft.issuer.trim() || saving}>Test</Button>
          <Button type="submit" loading={saving} disabled={!ready || testing}>Save</Button>
        </div>
      </form>
    </section>
  );
}

const errorText = (err: unknown, fallback: string) => {
  const e = err as { detail?: string } | null;
  return e?.detail ?? fallback;
};

export function SignInService({ headingClassName }: { headingClassName?: string | undefined } = {}) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: OIDC_SETTINGS_KEY, queryFn: () => api.get<OidcSettingsResponse>('/users/sign-in-service') });
  const { run, dialog } = useStepUpAction();
  const [draft, setDraft] = useState<SignInServiceDraft | null>(null);
  const [tested, setTested] = useState<OidcTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const test = useMutation({ mutationFn: (issuer: string) => testOidcIssuer(issuer) });
  const save = useMutation({
    mutationFn: (body: OidcSettingsRequest & { unlinkAll?: boolean }) => api.put<OidcSettingsResponse>('/users/sign-in-service', body),
    onSuccess: (view) => {
      queryClient.setQueryData(OIDC_SETTINGS_KEY, view);
      void queryClient.invalidateQueries({ queryKey: OIDC_PUBLIC_KEY });
      void queryClient.invalidateQueries({ queryKey: OIDC_LINK_KEY });
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });

  if (!settings.data) return null;
  const view = settings.data;
  const current = draft ?? draftFrom(view);

  const onTest = async () => {
    setError(null);
    setTested(null);
    try {
      setTested(await test.mutateAsync(current.issuer.trim()));
    } catch (err) {
      setError(errorText(err, 'The issuer did not answer.'));
    }
  };

  const onSave = async () => {
    setError(null);
    setTested(null);
    const body = requestFrom(current);
    try {
      const done = await run('Save the sign-in service', () => save.mutateAsync(body));
      if (done) setDraft(null);
    } catch (err) {
      const e = err as { status?: number; detail?: string };
      if (e.status === 409 && e.detail) {
        const ok = await confirmDialog({ title: 'Change the issuer?', message: <p>{e.detail}</p>, confirmLabel: 'Save and unlink', tone: 'danger' });
        if (!ok) return;
        try {
          const done = await run('Save the sign-in service', () => save.mutateAsync({ ...body, unlinkAll: true }));
          if (done) setDraft(null);
        } catch (err2) {
          setError(errorText(err2, 'Could not save.'));
        }
        return;
      }
      setError(errorText(err, 'Could not save.'));
    }
  };

  return (
    <>
      <SignInServiceForm
        view={view}
        draft={current}
        onChange={(d) => { setDraft(d); setTested(null); }}
        onTest={() => void onTest()}
        onSave={() => void onSave()}
        testing={test.isPending}
        saving={save.isPending}
        tested={tested}
        error={error}
        headingClassName={headingClassName}
      />
      {dialog}
    </>
  );
}
