/**
 * Your settings › Listening (each person's own): what the player knows as you. Your
 * own account on the player server (and a password for phone apps), your
 * Last.fm and ListenBrainz, and your recent plays with what was scrobbled.
 * Three groups (spec §6): Player account, Scrobbling, Recently played. The
 * phone password is a secret with its own Set / Replace / Forget, never in
 * a Save; an own login's User name, Password and Server scrobbles save
 * together with one Save (a half-typed login is never sent); Loves save
 * when changed, the outcome in the Scrobbling head.
 * ListeningSettingsView is the page alone, driven by props (stories,
 * tests); SettingsListeningContent connects it.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ListeningHistoryView, ListeningView, OwnPlayerAccount, PlayHistoryItem, ScrobbleAccountView, ScrobbleService } from '@tagave/shared';
import {
  Badge, Banner, Button, Input, SaveStatus, SegmentedControl, SettingsGroup, SettingsRow, SettingsSave, confirmDialog, useSaveFlash, useSettingsDraft, type SaveState,
} from '../components/ui';
import {
  useClearPhonePassword, useConnectLastfm, useConnectListenbrainz, useDisconnectScrobbler, useListening, useListeningHistory, useSetLoves,
  useRemoveOwnAccount, useSaveOwnAccount, useSetPhonePassword,
} from '../hooks/useListening';
import type { ApiError } from '../services/api';
import { formatRelativeTime, shortDate } from '../utils/time';
import styles from './SettingsListeningPage.module.css';

const problem = (err: unknown, fallback: string) => {
  const e = err as Partial<ApiError> | null;
  return e?.detail || e?.title || fallback;
};

const when = (iso: string | null) => shortDate(iso);

const SERVICE_NAME: Record<ScrobbleService, string> = { lastfm: 'Last.fm', listenbrainz: 'ListenBrainz' };

/** "12 recent plays will be sent" after connecting, or null when none were queued. */
export function queuedLine(queued: number | null | undefined): string | null {
  if (!queued || queued <= 0) return null;
  return queued === 1 ? '1 recent play queued' : `${queued} recent plays queued`;
}

/** What the person's browser came back from Last.fm with (?lastfm=…&queued=…). */
export function lastfmReturnMessage(result: string | null, queued: number | null = null): { tone: 'success' | 'danger'; text: string } | null {
  switch (result) {
    case 'connected': return { tone: 'success', text: queuedLine(queued) ? `Last.fm connected · ${queuedLine(queued)}` : 'Last.fm connected' };
    case 'expired': return { tone: 'danger', text: 'Last.fm sign-in expired. Try again.' };
    case 'refused': return { tone: 'danger', text: 'Last.fm access was not allowed. Try again.' };
    case 'unavailable': return { tone: 'danger', text: 'Last.fm is not set up on this server.' };
    case 'failed': return { tone: 'danger', text: 'Last.fm sign-in failed. Try again.' };
    default: return null;
  }
}

const ON_OFF = [{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }];

/** A save's outcome for a part of the page (the save model). */
export interface ListeningSave {
  state: SaveState;
  detail?: string | null;
}

export interface ListeningSettingsViewProps {
  data: ListeningView;
  history: ListeningHistoryView | null;
  /** ?lastfm= after the browser came back from Last.fm */
  lastfmReturn: string | null;
  /** ?queued= with it: recent plays queued for Last.fm on connect */
  lastfmQueued?: number | null;
  /** recent plays queued for ListenBrainz by the connect just made */
  listenbrainzQueued?: number | null;
  busy?: Partial<Record<'lastfm' | 'listenbrainz' | 'phone' | 'account' | 'disconnect', boolean>>;
  errors?: Partial<Record<'lastfm' | 'listenbrainz' | 'phone' | 'account', string | null>>;
  /** what was just saved: the own login, the phone password, a Loves choice */
  saves?: Partial<Record<'account' | 'phone' | 'loves', ListeningSave>>;
  onConnectLastfm: () => void;
  onConnectListenbrainz: (token: string) => void;
  onDisconnect: (service: ScrobbleService) => void;
  /** liked songs as loves on a connection: Off or On */
  onLoves?: ((service: ScrobbleService, on: boolean) => void) | undefined;
  onSetPhonePassword: (password: string) => void;
  onClearPhonePassword: () => void;
  onSaveOwnAccount: (body: OwnPlayerAccount) => void;
  onRemoveOwnAccount: () => void;
}

export function ListeningSettingsView(props: ListeningSettingsViewProps) {
  const { data, history, lastfmReturn, lastfmQueued = null } = props;
  const back = lastfmReturnMessage(lastfmReturn, lastfmQueued);
  if (!data.playerInstalled) {
    return <p className={styles.muted}>Player not set up</p>;
  }
  return (
    <div className={styles.page}>
      {back && <Banner tone={back.tone}>{back.text}</Banner>}
      <AccountGroup {...props} />
      <ScrobblingGroup {...props} />
      <HistoryGroup history={history} />
    </div>
  );
}

/** Calls `fn` once each time `state` turns to saved (a field to clear after it went). */
function useOnSaved(state: SaveState | undefined, fn: () => void) {
  const was = useRef(state);
  const latest = useRef(fn);
  useEffect(() => { latest.current = fn; });
  useEffect(() => {
    if (state === 'saved' && was.current !== 'saved') latest.current();
    was.current = state;
  }, [state]);
}

// ---- your account on the player ----

function AccountGroup({ data, busy, errors, saves, onSetPhonePassword, onClearPhonePassword, onSaveOwnAccount, onRemoveOwnAccount }: ListeningSettingsViewProps) {
  const a = data.account;
  if (a.kind === 'bundled') {
    return (
      <PhonePasswordGroup
        username={a.username}
        locked={a.state === 'disabled'}
        hasOne={a.phonePassword}
        busy={!!busy?.phone}
        error={errors?.phone ?? null}
        saved={saves?.phone?.state ?? null}
        onSave={onSetPhonePassword}
        onClear={onClearPhonePassword}
      />
    );
  }
  return (
    <OwnLoginGroup
      account={a}
      busy={!!busy?.account}
      error={errors?.account ?? null}
      saved={saves?.account?.state ?? null}
      onSave={onSaveOwnAccount}
      onRemove={onRemoveOwnAccount}
    />
  );
}

interface PhonePasswordGroupProps {
  username: string | null;
  locked: boolean;
  hasOne: boolean;
  busy: boolean;
  error: string | null;
  saved: SaveState;
  onSave: (p: string) => void;
  onClear: () => void;
}

/** The bundled player: who you are on it, and the phone password (a secret: its own Set / Replace / Forget). */
function PhonePasswordGroup({ username, locked, hasOne, busy, error, saved, onSave, onClear }: PhonePasswordGroupProps) {
  const [password, setPassword] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  useOnSaved(saved, () => setPassword(''));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    if (password.length < 12) { setInvalid('Too short'); return; }
    setInvalid(null);
    onSave(password);
  };
  const clear = async () => {
    const ok = await confirmDialog({
      title: 'Forget the password for apps?',
      message: 'Apps signed in with it stop working.',
      confirmLabel: 'Forget',
      tone: 'danger',
    });
    if (ok) onClear();
  };
  const problem = invalid ?? error;
  return (
    <form onSubmit={submit} noValidate>
      <SettingsGroup title="Player account" meta={locked ? <Badge tone="danger">Locked</Badge> : null}>
        <SettingsRow as="div" label="User name" value={<span className={styles.value}>{username ?? 'Unknown'}</span>} />
        <SettingsRow as="div" label="Subsonic port" value={<span className={styles.value}>4533</span>} />
        <SettingsRow
          as="div"
          label="Phone password"
          help="Phone and desktop apps sign in to the player with your user name and this password. At least 12 characters."
          value={<span className={styles.short}>{hasOne ? 'Set' : 'Not set'}</span>}
        >
          <span className={styles.control}>
          <Input
            dense
            className={styles.field}
            type="password"
            autoComplete="new-password"
            aria-label="Phone password"
            placeholder="12+ characters"
            value={password}
            onChange={(e) => { setPassword(e.currentTarget.value); setInvalid(null); }}
            disabled={locked}
            aria-invalid={problem ? true : undefined}
          />
          <Button type="submit" size="sm" variant="secondary" loading={busy} disabled={locked || !password}>{hasOne ? 'Replace' : 'Set'}</Button>
          {hasOne && <Button size="sm" variant="quiet-danger" onClick={() => void clear()} disabled={busy}>Forget</Button>}
          {problem ? <span className={styles.fieldError} role="alert">{problem}</span> : <SaveStatus state={saved} />}
          </span>
        </SettingsRow>
      </SettingsGroup>
    </form>
  );
}

type OwnLoginDraft = { username: string; password: string; serverScrobbles: boolean };

interface OwnLoginGroupProps {
  account: ListeningView['account'];
  busy: boolean;
  error: string | null;
  saved: SaveState;
  onSave: (b: OwnPlayerAccount) => void;
  onRemove: () => void;
}

/** The owner's own server: the shared account, or your own login there, saved with one Save. */
function OwnLoginGroup({ account, busy, error, saved, onSave, onRemove }: OwnLoginGroupProps) {
  const own = account.kind === 'own';
  const savedName = own ? account.username ?? '' : '';
  const savedScrobbles = own ? account.serverScrobbles : false;
  const base = useMemo<OwnLoginDraft>(() => ({ username: savedName, password: '', serverScrobbles: savedScrobbles }), [savedName, savedScrobbles]);
  const { draft, set, dirty, reset } = useSettingsDraft<OwnLoginDraft>(base);
  useOnSaved(saved, reset);
  const d = draft ?? base;
  const ready = dirty && !!d.username.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    onSave({ username: d.username.trim(), ...(d.password ? { password: d.password } : {}), serverScrobbles: d.serverScrobbles });
  };
  const after = (
    <div className={styles.actions}>
      <SettingsSave type="submit" label={own ? 'Save' : 'Add login'} dirty={ready} pending={busy} onSave={() => undefined} state={error ? 'failed' : saved} detail={error} />
      {own && <Button variant="quiet-danger" onClick={onRemove} disabled={busy}>Use shared</Button>}
    </div>
  );
  return (
    <form onSubmit={submit} noValidate>
      <SettingsGroup title="Player account" after={after}>
        {!own && <SettingsRow as="div" label="Account" value={<span className={styles.value}>Shared account</span>} />}
        <SettingsRow label="User name">
          <Input dense className={styles.field} autoComplete="username" value={d.username} onChange={(e) => set({ username: e.currentTarget.value })} required />
        </SettingsRow>
        <SettingsRow label="Password" help={own ? 'Leave it empty to keep the saved one' : undefined}>
          <Input dense className={styles.field} type="password" autoComplete="current-password" placeholder={own ? 'Saved' : undefined} value={d.password} onChange={(e) => set({ password: e.currentTarget.value })} />
        </SettingsRow>
        <SettingsRow as="div" label="Server scrobbles" help="On: your server sends your scrobbles itself, so tagave does not">
          <SegmentedControl label="Server scrobbles" value={d.serverScrobbles ? 'on' : 'off'} onChange={(v) => set({ serverScrobbles: v === 'on' })} options={ON_OFF} />
        </SettingsRow>
      </SettingsGroup>
    </form>
  );
}

// ---- scrobbling ----

/** One line per connected service: who, when something last went through, what waits. */
export function serviceLine(s: ScrobbleAccountView): string {
  return [s.accountName ?? '', sentLine(s)].join(' · ');
}

/** When something last went through, and what waits. */
export function sentLine(s: ScrobbleAccountView): string {
  const parts = [s.lastOkAt ? `Last sent ${formatRelativeTime(s.lastOkAt)}` : 'Nothing sent yet'];
  if (s.pending > 0) parts.push(`${s.pending} waiting`);
  return parts.join(' · ');
}

const connectedValue = (s: ScrobbleAccountView) => (s.accountName ? `Connected · ${s.accountName}` : 'Connected');

interface ConnectedRowsProps {
  s: ScrobbleAccountView;
  queued?: number | null | undefined;
  disconnecting: boolean;
  onDisconnect: () => void;
  onLoves?: ((service: ScrobbleService, on: boolean) => void) | undefined;
}

/** A connected service: who, what went through, its Loves (saved when changed). */
function ConnectedRows({ s, queued = null, disconnecting, onDisconnect, onLoves }: ConnectedRowsProps) {
  const name = SERVICE_NAME[s.service];
  return (
    <>
      <SettingsRow as="div" label={name} value={<span className={styles.value}>{connectedValue(s)}</span>}>
        <Button variant="quiet-danger" size="sm" onClick={onDisconnect} disabled={disconnecting} aria-label={`Disconnect ${name}`}>Disconnect</Button>
      </SettingsRow>
      <SettingsRow as="div" label="Sent" value={<span className={styles.value}>{sentLine(s)}</span>}>
        {queuedLine(queued) && <span className={styles.ok} role="status">{queuedLine(queued)}</span>}
        {s.lastError && <span className={styles.fieldError} role="alert">{s.lastError}{s.lastErrorAt ? ` (${formatRelativeTime(s.lastErrorAt)})` : ''}</span>}
      </SettingsRow>
      <SettingsRow as="div" label="Loves" help={`Liked songs go to ${name} as loves`}>
        <SegmentedControl label={`Loves on ${name}`} size="sm" value={s.loves !== false ? 'on' : 'off'} onChange={(v) => onLoves?.(s.service, v === 'on')} options={ON_OFF} />
      </SettingsRow>
    </>
  );
}

function ScrobblingGroup({ data, busy, errors, saves, listenbrainzQueued, onConnectLastfm, onConnectListenbrainz, onDisconnect, onLoves }: ListeningSettingsViewProps) {
  const lastfm = data.services.find((s) => s.service === 'lastfm');
  const lb = data.services.find((s) => s.service === 'listenbrainz');
  const lbForm = useId();
  const disconnect = async (service: ScrobbleService) => {
    const ok = await confirmDialog({
      title: `Disconnect ${SERVICE_NAME[service]}?`,
      message: 'Scrobbles still waiting are dropped.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    });
    if (ok) onDisconnect(service);
  };
  return (
    <SettingsGroup
      title="Scrobbling"
      status={<SaveStatus state={saves?.loves?.state ?? null} detail={saves?.loves?.detail ?? null} />}
      after={!lb?.connected ? <ListenbrainzForm id={lbForm} onConnect={onConnectListenbrainz} /> : null}
    >
      {data.account.serverScrobbles && <SettingsRow as="div" label="Scrobbled by" value={<span className={styles.value}>Your server</span>} />}
      {lastfm?.connected ? (
        <ConnectedRows s={lastfm} disconnecting={!!busy?.disconnect} onDisconnect={() => void disconnect('lastfm')} onLoves={onLoves} />
      ) : data.lastfmAvailable ? (
        <SettingsRow as="div" label="Last.fm" value={<span className={styles.value}>Not connected</span>}>
          <Button size="sm" loading={!!busy?.lastfm} onClick={onConnectLastfm} aria-label="Connect Last.fm">Connect</Button>
          {errors?.lastfm && <span className={styles.fieldError} role="alert">{errors.lastfm}</span>}
        </SettingsRow>
      ) : (
        <SettingsRow as="div" label="Last.fm" value={<span className={styles.value}>Not set up on this server</span>} />
      )}
      {lb?.connected ? (
        <ConnectedRows s={lb} queued={listenbrainzQueued} disconnecting={!!busy?.disconnect} onDisconnect={() => void disconnect('listenbrainz')} onLoves={onLoves} />
      ) : (
        <ListenbrainzRow form={lbForm} busy={!!busy?.listenbrainz} error={errors?.listenbrainz ?? null} />
      )}
    </SettingsGroup>
  );
}

/** The ListenBrainz form itself sits outside the rows; its field and button join it by id. */
function ListenbrainzForm({ id, onConnect }: { id: string; onConnect: (token: string) => void }) {
  return (
    <form
      id={id}
      hidden
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const token = String(new FormData(e.currentTarget).get('token') ?? '').trim();
        if (token) onConnect(token);
      }}
    />
  );
}

function ListenbrainzRow({ form, busy, error }: { form: string; busy: boolean; error: string | null }) {
  const [token, setToken] = useState('');
  return (
    <SettingsRow
      as="div"
      label="ListenBrainz"
      help={<>Paste your user token from ListenBrainz. <a href="https://listenbrainz.org/settings/" target="_blank" rel="noreferrer">Get your token</a></>}
      value={<span className={styles.short}>Not connected</span>}
    >
      <span className={styles.control}>
      <Input
        dense
        form={form}
        name="token"
        className={styles.field}
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label="ListenBrainz user token"
        placeholder="User token"
        value={token}
        onChange={(e) => setToken(e.currentTarget.value)}
        aria-invalid={error ? true : undefined}
      />
      <Button form={form} type="submit" size="sm" variant="secondary" loading={busy} disabled={!token.trim()} aria-label="Connect ListenBrainz">Connect</Button>
      {error && <span className={styles.fieldError} role="alert">{error}</span>}
      </span>
    </SettingsRow>
  );
}

// ---- history ----

function playStatus(p: PlayHistoryItem): string {
  if (!p.scrobbles) return 'Not counted';
  if (p.scrobbled.length === 0) return 'Counted';
  if (p.scrobbled.every((s) => s.status === 'sent')) return 'Scrobbled';
  return p.scrobbled.filter((s) => s.status !== 'sent').map((s) => {
    const name = SERVICE_NAME[s.service];
    switch (s.status) {
      case 'pending': case 'sending': return `${name} waiting`;
      case 'ignored': return `${name} did not keep it${s.error ? ` (${s.error})` : ''}`;
      default: return `Not sent to ${name}${s.error ? ` (${s.error})` : ''}`;
    }
  }).join(' · ');
}

function HistoryGroup({ history }: { history: ListeningHistoryView | null }) {
  const plays = history?.plays ?? [];
  return (
    <SettingsGroup
      title="Recently played"
      meta={!history ? 'Loading…' : plays.length === 0 ? 'No plays yet' : null}
      after={plays.length > 0 ? (
        <ul className={styles.plays}>
          {plays.map((p) => (
            <li key={p.id} className={styles.play}>
              <div className={styles.playMain}>
                <span className={styles.playTitle} dir="auto">{p.title}</span>
                <span className={styles.playSub} dir="auto">{[p.artist, p.album].filter(Boolean).join(' · ')}</span>
              </div>
              <div className={styles.playMeta}>
                <span className={styles.playWhen}>{when(p.startedAt)}{p.source === 'web' ? '' : ' · another app'}</span>
                <span className={styles.playStatus}>{playStatus(p)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    />
  );
}

// ---- connected ----

export function SettingsListeningContent() {
  const listening = useListening();
  const history = useListeningHistory();
  const lastfm = useConnectLastfm();
  const lb = useConnectListenbrainz();
  const disconnect = useDisconnectScrobbler();
  const loves = useSetLoves();
  const phone = useSetPhonePassword();
  const clearPhone = useClearPhonePassword();
  const saveOwn = useSaveOwnAccount();
  const removeOwn = useRemoveOwnAccount();
  const lovesSave = useSaveFlash();
  const phoneSave = useSaveFlash();
  const accountSave = useSaveFlash();
  const [{ lastfmReturn, lastfmQueued }] = useState(() => {
    try {
      const q = new URLSearchParams(globalThis.location?.search ?? '');
      return { lastfmReturn: q.get('lastfm'), lastfmQueued: Number(q.get('queued')) || null };
    } catch { return { lastfmReturn: null, lastfmQueued: null }; }
  });
  // the ?lastfm= note is read once; the address goes back to plain /you/listening
  useEffect(() => {
    if (lastfmReturn) {
      try { globalThis.history?.replaceState(globalThis.history.state, '', globalThis.location.pathname); } catch { /* keep it */ }
    }
  }, [lastfmReturn]);
  return (
    <>
      {listening.isLoading && <p className={styles.muted}>Loading…</p>}
      {listening.isError && <Banner tone="danger">Couldn’t load listening settings. {problem(listening.error, '')}</Banner>}
      {listening.data && (
        <ListeningSettingsView
          data={listening.data}
          history={history.data ?? null}
          lastfmReturn={lastfmReturn}
          lastfmQueued={lastfmQueued}
          listenbrainzQueued={lb.data?.queued ?? null}
          busy={{ lastfm: lastfm.isPending, listenbrainz: lb.isPending, phone: phone.isPending || clearPhone.isPending, account: saveOwn.isPending || removeOwn.isPending, disconnect: disconnect.isPending }}
          errors={{
            lastfm: lastfm.isError ? problem(lastfm.error, 'Last.fm could not be reached.') : null,
            listenbrainz: lb.isError ? problem(lb.error, 'ListenBrainz did not accept the token.') : null,
            phone: phone.isError ? problem(phone.error, 'The player did not take the password.') : clearPhone.isError ? problem(clearPhone.error, 'Not saved') : null,
            account: saveOwn.isError || removeOwn.isError ? problem(saveOwn.error ?? removeOwn.error, 'The server did not accept these details.') : null,
          }}
          onConnectLastfm={() => lastfm.mutate()}
          onConnectListenbrainz={(token) => lb.mutate(token)}
          onDisconnect={(s) => disconnect.mutate(s)}
          saves={{ loves: { state: lovesSave.state, detail: lovesSave.detail }, phone: { state: phoneSave.state }, account: { state: accountSave.state } }}
          onLoves={(service, on) => {
            lovesSave.clear();
            loves.mutate({ service, on }, { onSuccess: () => lovesSave.saved(), onError: (err) => lovesSave.failed(problem(err, '') || null) });
          }}
          onSetPhonePassword={(p) => { phoneSave.clear(); clearPhone.reset(); phone.mutate(p, { onSuccess: () => phoneSave.saved() }); }}
          // Forget reports like Set: ✓ Saved, or the failure as the group's alert
          onClearPhonePassword={() => { phoneSave.clear(); phone.reset(); clearPhone.mutate(undefined, { onSuccess: () => phoneSave.saved() }); }}
          onSaveOwnAccount={(b) => { accountSave.clear(); saveOwn.mutate(b, { onSuccess: () => accountSave.saved() }); }}
          onRemoveOwnAccount={() => removeOwn.mutate()}
        />
      )}
    </>
  );
}
