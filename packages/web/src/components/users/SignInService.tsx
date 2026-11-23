/**
 * Settings › People › Sign-in service (owner): your own login service
 * (OpenID Connect: Zitadel, Authentik, Authelia, Keycloak, Pocket ID), as
 * two groups under People (spec §6). `Sign-in service`: Name, Issuer,
 * Client ID, Client secret, the Redirect URI, Test and one Save. `Join`:
 * Sign-in button and Anyone can join as Off | On, and the Group.
 *
 * A service not saved yet is one connection: everything, the choices too,
 * goes with the one Save (a half-typed service is never sent). Once one is
 * saved, the choices save when changed and the Group has its own Save:
 * each sends the saved settings with that one change, the client secret
 * left out (the API keeps it), behind the same step-up. The client secret
 * is then a secret of its own (Set / Replace / Forget), never part of a
 * Save; it is sent, never shown. Saving asks for a fresh confirmation
 * (useStepUpAction).
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OidcSettingsRequest, OidcSettingsResponse, OidcTestResult } from '@tagave/shared';
import { Badge, Banner, Button, Input, SaveStatus, SegmentedControl, SettingsGroup, SettingsRow, SettingsSave, askFirst, confirmDialog, showToast, useSaveFlash, type SaveState } from '../ui';
import { SecretRow } from '../settings/SecretRow';
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

/** What a saved service changes on its own: a choice, the Group, or the client secret (null: none). */
export type InstantPatch = Partial<Pick<SignInServiceDraft, 'enabled' | 'joinEnabled' | 'joinGroup'>> & { clientSecret?: string | null };

/**
 * A saved service's settings with one change: the secret left out (the API
 * keeps the stored one) unless the change is the secret.
 */
export function instantRequest(view: OidcSettingsResponse, patch: InstantPatch): OidcSettingsRequest {
  const { clientSecret, ...rest } = patch;
  return { ...requestFrom({ ...draftFrom(view), ...rest }), ...(clientSecret !== undefined ? { clientSecret } : {}) };
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

const ON_OFF = (disabled: boolean) => [{ value: 'off' as const, label: 'Off', disabled }, { value: 'on' as const, label: 'On', disabled }];

/** A save's progress and outcome. */
export interface ServiceSave {
  pending?: boolean;
  state?: SaveState;
  detail?: string | null;
}

export interface SignInServiceFormProps {
  view: OidcSettingsResponse;
  draft: SignInServiceDraft;
  onChange: (d: SignInServiceDraft) => void;
  onTest: () => void;
  /** the first group's Save */
  onSave: () => void;
  /** a saved service: a choice or the client secret, saved at once */
  onInstant?: (patch: InstantPatch) => void;
  /** a saved service: the Group's own Save */
  onSaveGroup?: (group: string) => void;
  testing?: boolean;
  tested?: OidcTestResult | null;
  /** the first group's Save */
  service?: ServiceSave;
  /** the choices, in Join's head */
  join?: ServiceSave;
  group?: ServiceSave;
  secret?: ServiceSave;
}

/** The redirect URI, read-only, and Copy. */
function RedirectUri({ uri }: { uri: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      showToast({ message: 'Redirect URI copied' });
    } catch {
      input.current?.select();
    }
  };
  return (
    <span className={styles.control}>
      <Input ref={input} dense readOnly value={uri} aria-label="Redirect URI" onFocus={(e) => e.currentTarget.select()} className={`${styles.linkInput} ${styles.field}`} />
      <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
    </span>
  );
}

/** The form, without data fetching or hooks (Storybook renders it with fixtures; tests call its controls). */
export function SignInServiceForm({
  view, draft, onChange, onTest, onSave, onInstant = () => undefined, onSaveGroup = () => undefined,
  testing = false, tested = null, service = {}, join = {}, group = {}, secret = {},
}: SignInServiceFormProps) {
  const saved = view.settings;
  const state = serviceState(view);
  const set = <K extends keyof SignInServiceDraft>(k: K, v: SignInServiceDraft[K]) => onChange({ ...draft, [k]: v });
  const ready = !!(draft.name.trim() && draft.issuer.trim() && draft.clientId.trim());
  // a saved service: Save sends the typed fields; a new one: everything
  const typed = saved
    ? draft.name.trim() !== saved.name || draft.issuer.trim() !== saved.issuer || draft.clientId.trim() !== saved.clientId
    : true;
  const dirty = ready && typed;
  // the choices: a saved service's as saved (they save at once), a new one's in the draft
  const enabled = saved ? saved.enabled : draft.enabled;
  const joinEnabled = saved ? saved.joinEnabled : draft.joinEnabled;
  const choose = (k: 'enabled' | 'joinEnabled', on: boolean) => {
    if (saved) { if (!join.pending) onInstant({ [k]: on }); } else set(k, on);
  };
  const groupDirty = !!saved && draft.joinGroup.trim() !== (saved.joinGroup ?? '');
  const busy = !!service.pending;
  return (
    <>
      {view.secretUnreadable && <Banner tone="warning">Enter the client secret again.</Banner>}
      <form noValidate onSubmit={(e) => { e.preventDefault(); if (dirty && !busy) onSave(); }}>
        <SettingsGroup
          title="Sign-in service"
          meta={state !== 'none' ? <Badge tone={STATE_BADGE[state].tone}>{STATE_BADGE[state].label}</Badge> : null}
          after={(
            <div className={styles.actions}>
              <Button type="button" variant="secondary" size="sm" onClick={onTest} loading={testing} disabled={!draft.issuer.trim() || busy}>Test</Button>
              <SettingsSave type="submit" dirty={dirty && !testing} pending={busy} state={service.state ?? null} detail={service.detail ?? null} onSave={onSave} />
              {tested && <span className={styles.value} role="status">Found {tested.issuer}</span>}
            </div>
          )}
        >
          <SettingsRow label="Name">
            <Input dense className={styles.field} required value={draft.name} maxLength={60} placeholder="Zitadel" autoComplete="off" onChange={(e) => set('name', e.target.value)} />
          </SettingsRow>
          <SettingsRow label="Issuer">
            <Input dense className={styles.field} required type="url" value={draft.issuer} placeholder="https://auth.example.com" autoComplete="off" spellCheck={false} onChange={(e) => set('issuer', e.target.value)} />
          </SettingsRow>
          <SettingsRow label="Client ID">
            <Input dense className={styles.field} required value={draft.clientId} autoComplete="off" spellCheck={false} onChange={(e) => set('clientId', e.target.value)} />
          </SettingsRow>
          {saved ? (
            <SecretRow
              label="Client secret"
              help="None for a public client"
              set={saved.secretSet}
              placeholder="Client secret"
              pending={secret.pending}
              state={secret.state}
              detail={secret.detail}
              onSet={(v) => onInstant({ clientSecret: v })}
              onForget={() => onInstant({ clientSecret: null })}
            />
          ) : (
            <SettingsRow label="Client secret" help="None for a public client">
              <Input dense className={styles.field} type="password" value={draft.clientSecret} placeholder="Not set" autoComplete="new-password" onChange={(e) => set('clientSecret', e.target.value)} />
            </SettingsRow>
          )}
          <SettingsRow as="div" label="Redirect URI" help="Add this address to the client in your login service">
            <RedirectUri uri={view.redirectUri} />
          </SettingsRow>
        </SettingsGroup>
      </form>
      <form noValidate onSubmit={(e) => { e.preventDefault(); if (groupDirty && !group.pending) onSaveGroup(draft.joinGroup.trim()); }}>
        <SettingsGroup
          title="Join"
          status={saved ? <SaveStatus state={join.state ?? null} detail={join.detail ?? null} /> : null}
          after={saved && joinEnabled ? (
            <SettingsSave type="submit" label="Save group" dirty={groupDirty} pending={!!group.pending} state={group.state ?? null} detail={group.detail ?? null} onSave={() => onSaveGroup(draft.joinGroup.trim())} />
          ) : null}
        >
          <SettingsRow as="div" label="Sign-in button" help={saved ? `Sign in with ${saved.name} on the sign-in page` : 'On the sign-in page'}>
            <SegmentedControl label="Sign-in button" value={enabled ? 'on' : 'off'} onChange={(v) => choose('enabled', v === 'on')} options={ON_OFF(!!join.pending)} />
          </SettingsRow>
          <SettingsRow as="div" label="Anyone can join" help="Someone new who signs in with the service joins as a listener">
            <SegmentedControl label="Anyone can join" value={joinEnabled ? 'on' : 'off'} onChange={(v) => choose('joinEnabled', v === 'on')} options={ON_OFF(!!join.pending)} />
          </SettingsRow>
          {joinEnabled && (
            <SettingsRow label="Group" help="Only people in this group may join; empty for anyone">
              <Input dense className={styles.field} value={draft.joinGroup} maxLength={255} placeholder="Any" autoComplete="off" spellCheck={false} onChange={(e) => set('joinGroup', e.target.value)} />
            </SettingsRow>
          )}
        </SettingsGroup>
      </form>
    </>
  );
}

const errorText = (err: unknown, fallback: string) => {
  const e = err as { detail?: string } | null;
  return e?.detail ?? fallback;
};

export function SignInService() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: OIDC_SETTINGS_KEY, queryFn: () => api.get<OidcSettingsResponse>('/users/sign-in-service') });
  const { run, dialog } = useStepUpAction();
  const [draft, setDraft] = useState<SignInServiceDraft | null>(null);
  const [tested, setTested] = useState<OidcTestResult | null>(null);
  const serviceFlash = useSaveFlash();
  const joinFlash = useSaveFlash();
  const groupFlash = useSaveFlash();
  const secretFlash = useSaveFlash();
  const [pending, setPending] = useState<'service' | 'join' | 'group' | 'secret' | null>(null);
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
  const flashes = { service: serviceFlash, join: joinFlash, group: groupFlash, secret: secretFlash };

  /** One PUT behind the step-up; true once it is saved. */
  const put = async (which: keyof typeof flashes, body: OidcSettingsRequest): Promise<boolean> => {
    const flash = flashes[which];
    flash.clear();
    setPending(which);
    try {
      const done = await run('Save the sign-in service', () => save.mutateAsync(body));
      if (done) flash.saved();
      return !!done;
    } catch (err) {
      const e = err as { status?: number; detail?: string };
      if (e.status === 409 && e.detail) {
        const ok = await confirmDialog({ title: 'Change the issuer?', message: <p>{e.detail}</p>, confirmLabel: 'Save and unlink', tone: 'danger' });
        if (!ok) return false;
        try {
          const done = await run('Save the sign-in service', () => save.mutateAsync({ ...body, unlinkAll: true }));
          if (done) flash.saved();
          return !!done;
        } catch (err2) {
          flash.failed(errorText(err2, ''));
          return false;
        }
      }
      flash.failed(errorText(err, ''));
      return false;
    } finally {
      setPending(null);
    }
  };

  const onTest = async () => {
    setTested(null);
    serviceFlash.clear();
    try {
      setTested(await test.mutateAsync(current.issuer.trim()));
    } catch (err) {
      serviceFlash.failed(errorText(err, 'The issuer did not answer.'));
    }
  };

  // a saved service's Save sends the typed fields over the saved choices; a new one everything
  const onSave = async () => {
    setTested(null);
    const saved = view.settings;
    const body = saved
      ? requestFrom({ ...draftFrom(view), name: current.name, issuer: current.issuer, clientId: current.clientId })
      : requestFrom(current);
    if (!(await put('service', body))) return;
    // a Group typed but not saved stays in the draft for its own Save
    const fresh = queryClient.getQueryData<OidcSettingsResponse>(OIDC_SETTINGS_KEY) ?? view;
    const keep = saved && current.joinGroup.trim() !== (saved.joinGroup ?? '');
    setDraft(keep ? { ...draftFrom(fresh), joinGroup: current.joinGroup } : null);
  };

  const onInstant = (patch: InstantPatch) => void (async () => {
    if (patch.clientSecret === null && !(await askFirst('forgetClientSecret'))) return;
    await put('clientSecret' in patch ? 'secret' : 'join', instantRequest(view, patch));
  })();
  const onSaveGroup = (joinGroup: string) => void put('group', instantRequest(view, { joinGroup }));
  const progress = (which: keyof typeof flashes) => ({ pending: pending === which, state: flashes[which].state, detail: flashes[which].detail });

  return (
    <>
      <SignInServiceForm
        view={view}
        draft={current}
        onChange={(d) => { setDraft(d); setTested(null); }}
        onTest={() => void onTest()}
        onSave={() => void onSave()}
        onInstant={onInstant}
        onSaveGroup={onSaveGroup}
        testing={test.isPending}
        tested={tested}
        service={progress('service')}
        join={progress('join')}
        group={progress('group')}
        secret={progress('secret')}
      />
      {dialog}
    </>
  );
}
