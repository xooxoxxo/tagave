/**
 * Settings › Listening (your account): what the player knows as you. Your
 * own account on the player server (and a password for phone apps), your
 * Last.fm and ListenBrainz, and your recent plays with what was scrobbled.
 * ListeningSettingsView is the page alone, driven by props (stories,
 * tests); SettingsListeningContent connects it.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ListeningHistoryView, ListeningView, OwnPlayerAccount, PlayHistoryItem, ScrobbleAccountView, ScrobbleService } from '@tagave/shared';
import { Badge, Banner, Button, SegmentedControl, TextField, confirmDialog } from '../components/ui';
import {
  useClearPhonePassword, useConnectLastfm, useConnectListenbrainz, useDisconnectScrobbler, useListening, useListeningHistory,
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

function Section({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.head}>
        <h3 id={id} className={styles.title}>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
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
  onConnectLastfm: () => void;
  onConnectListenbrainz: (token: string) => void;
  onDisconnect: (service: ScrobbleService) => void;
  onSetPhonePassword: (password: string) => void;
  onClearPhonePassword: () => void;
  onSaveOwnAccount: (body: OwnPlayerAccount) => void;
  onRemoveOwnAccount: () => void;
}

export function ListeningSettingsView(props: ListeningSettingsViewProps) {
  const { data, history, lastfmReturn, lastfmQueued = null } = props;
  const back = lastfmReturnMessage(lastfmReturn, lastfmQueued);
  if (!data.playerInstalled) {
    return <p className={styles.hint}>Player not set up</p>;
  }
  return (
    <div className={styles.page}>
      {back && <Banner tone={back.tone}>{back.text}</Banner>}
      <AccountSection {...props} />
      <ScrobblingSection {...props} />
      <HistorySection history={history} />
    </div>
  );
}

// ---- your account on the player ----

function AccountSection({ data, busy, errors, onSetPhonePassword, onClearPhonePassword, onSaveOwnAccount, onRemoveOwnAccount }: ListeningSettingsViewProps) {
  const a = data.account;
  if (a.kind === 'bundled') {
    return (
      <Section id="listening-account" title="Player account" aside={a.state === 'disabled' ? <Badge tone="danger">Locked</Badge> : null}>
        <p className={styles.hint}>
          {a.username ? <><strong className={styles.name}>{a.username}</strong> · Subsonic port 4533</> : 'Subsonic port 4533'}
        </p>
        <PhonePasswordForm
          key={a.phonePassword ? 'set' : 'unset'}
          hasOne={a.phonePassword}
          disabled={a.state === 'disabled'}
          busy={!!busy?.phone}
          error={errors?.phone ?? null}
          onSave={onSetPhonePassword}
          onClear={onClearPhonePassword}
        />
      </Section>
    );
  }
  return (
    <Section id="listening-account" title="Player account">
      {a.kind === 'shared'
        ? <p className={styles.hint}>Shared account</p>
        : <p className={styles.hint}>User name: <strong className={styles.name}>{a.username}</strong></p>}
      <OwnAccountForm account={a} busy={!!busy?.account} error={errors?.account ?? null} onSave={onSaveOwnAccount} onRemove={onRemoveOwnAccount} />
    </Section>
  );
}

function PhonePasswordForm({ hasOne, disabled, busy, error, onSave, onClear }: { hasOne: boolean; disabled: boolean; busy: boolean; error: string | null; onSave: (p: string) => void; onClear: () => void }) {
  const [password, setPassword] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 12) { setInvalid('Use at least 12 characters.'); return; }
    setInvalid(null);
    onSave(password);
  };
  const clear = async () => {
    const ok = await confirmDialog({
      title: 'Remove the password for apps?',
      message: 'Apps signed in with it stop working.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (ok) onClear();
  };
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <TextField
        label={hasOne ? 'New password for apps' : 'Password for apps'}
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        disabled={disabled}
        error={invalid ?? error ?? undefined}
        placeholder="12+ characters"
      />
      <div className={styles.row}>
        <Button type="submit" variant="secondary" loading={busy} disabled={disabled}>{hasOne ? 'Change password' : 'Set password'}</Button>
        {hasOne && <Button variant="quiet-danger" onClick={() => void clear()} disabled={busy}>Remove</Button>}
      </div>
    </form>
  );
}

function OwnAccountForm({ account, busy, error, onSave, onRemove }: { account: ListeningView['account']; busy: boolean; error: string | null; onSave: (b: OwnPlayerAccount) => void; onRemove: () => void }) {
  const own = account.kind === 'own';
  const [username, setUsername] = useState(own ? account.username ?? '' : '');
  const [password, setPassword] = useState('');
  const [serverScrobbles, setServerScrobbles] = useState(own ? account.serverScrobbles : false);
  useEffect(() => { if (own) { setUsername(account.username ?? ''); setServerScrobbles(account.serverScrobbles); } }, [own, account.username, account.serverScrobbles]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({ username: username.trim(), ...(password ? { password } : {}), serverScrobbles });
  };
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <TextField label="User name" autoComplete="username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} required />
      <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} hint={own ? 'Saved' : undefined} error={error ?? undefined} />
      <div className={styles.choice}>
        <span className={styles.choiceLabel} aria-hidden="true">Scrobbled by</span>
        <SegmentedControl
          label="Scrobbled by"
          value={serverScrobbles ? 'server' : 'tagave'}
          onChange={(v) => setServerScrobbles(v === 'server')}
          options={[{ value: 'tagave', label: 'tagave' }, { value: 'server', label: 'That server' }]}
        />

      </div>
      <div className={styles.row}>
        <Button type="submit" variant="secondary" loading={busy} disabled={!username.trim()}>{own ? 'Save' : 'Add login'}</Button>
        {own && <Button variant="quiet-danger" onClick={onRemove} disabled={busy}>Use shared</Button>}
      </div>
    </form>
  );
}

// ---- scrobbling ----

/** One line per connected service: who, when something last went through, what waits. */
export function serviceLine(s: ScrobbleAccountView): string {
  const parts = [s.accountName ?? '', s.lastOkAt ? `Last sent ${formatRelativeTime(s.lastOkAt)}` : 'Nothing sent yet'];
  if (s.pending > 0) parts.push(`${s.pending} waiting`);
  return parts.join(' · ');
}

function ScrobblingSection({ data, busy, errors, listenbrainzQueued, onConnectLastfm, onConnectListenbrainz, onDisconnect }: ListeningSettingsViewProps) {
  const lastfm = data.services.find((s) => s.service === 'lastfm');
  const lb = data.services.find((s) => s.service === 'listenbrainz');
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
    <Section id="listening-scrobbling" title="Scrobbling">
      {data.account.serverScrobbles && <Banner tone="info">Your server scrobbles for you</Banner>}
      <ul className={styles.services}>
        <li className={styles.service}>
          <div className={styles.serviceHead}>
            <span className={styles.serviceName}>Last.fm</span>
          </div>
          {lastfm?.connected ? (
            <>
              <p className={styles.hint}>{serviceLine(lastfm)}</p>
              {lastfm.lastError && <p className={styles.error} role="alert">{lastfm.lastError}{lastfm.lastErrorAt ? ` (${formatRelativeTime(lastfm.lastErrorAt)})` : ''}</p>}
              <div className={styles.row}><Button variant="quiet-danger" size="sm" onClick={() => void disconnect('lastfm')} disabled={busy?.disconnect}>Disconnect</Button></div>
            </>
          ) : data.lastfmAvailable ? (
            <>
              {errors?.lastfm && <p className={styles.error} role="alert">{errors.lastfm}</p>}
              <div className={styles.row}><Button loading={!!busy?.lastfm} onClick={onConnectLastfm} aria-label="Connect Last.fm">Connect</Button></div>
            </>
          ) : (
            <p className={styles.hint}>Not set up on this server</p>
          )}
        </li>
        <li className={styles.service}>
          <div className={styles.serviceHead}>
            <span className={styles.serviceName}>ListenBrainz</span>
          </div>
          {lb?.connected ? (
            <>
              <p className={styles.hint}>{serviceLine(lb)}</p>
              {queuedLine(listenbrainzQueued) && <p className={styles.ok} role="status">{queuedLine(listenbrainzQueued)}</p>}
              {lb.lastError && <p className={styles.error} role="alert">{lb.lastError}{lb.lastErrorAt ? ` (${formatRelativeTime(lb.lastErrorAt)})` : ''}</p>}
              <div className={styles.row}><Button variant="quiet-danger" size="sm" onClick={() => void disconnect('listenbrainz')} disabled={busy?.disconnect}>Disconnect</Button></div>
            </>
          ) : (
            <ListenbrainzForm busy={!!busy?.listenbrainz} error={errors?.listenbrainz ?? null} onConnect={onConnectListenbrainz} />
          )}
        </li>
      </ul>
    </Section>
  );
}

function ListenbrainzForm({ busy, error, onConnect }: { busy: boolean; error: string | null; onConnect: (token: string) => void }) {
  const [token, setToken] = useState('');
  return (
    <form className={styles.form} onSubmit={(e) => { e.preventDefault(); if (token.trim()) onConnect(token.trim()); }} noValidate>
      <TextField
        label="User token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(e) => setToken(e.currentTarget.value)}
        error={error ?? undefined}
        hint={<a href="https://listenbrainz.org/settings/" target="_blank" rel="noreferrer">Get your token</a>}
      />
      <div className={styles.row}><Button type="submit" variant="secondary" loading={busy} disabled={!token.trim()} aria-label="Connect ListenBrainz">Connect</Button></div>
    </form>
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

function HistorySection({ history }: { history: ListeningHistoryView | null }) {
  return (
    <Section id="listening-history" title="Recently played">
      {!history ? <p className={styles.muted}>Loading…</p> : history.plays.length === 0 ? (
        <p className={styles.hint}>No plays yet</p>
      ) : (
        <>
          <ul className={styles.plays}>
            {history.plays.map((p) => (
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
        </>
      )}
    </Section>
  );
}

// ---- connected ----

export function SettingsListeningContent() {
  const listening = useListening();
  const history = useListeningHistory();
  const lastfm = useConnectLastfm();
  const lb = useConnectListenbrainz();
  const disconnect = useDisconnectScrobbler();
  const phone = useSetPhonePassword();
  const clearPhone = useClearPhonePassword();
  const saveOwn = useSaveOwnAccount();
  const removeOwn = useRemoveOwnAccount();
  const [{ lastfmReturn, lastfmQueued }] = useState(() => {
    try {
      const q = new URLSearchParams(globalThis.location?.search ?? '');
      return { lastfmReturn: q.get('lastfm'), lastfmQueued: Number(q.get('queued')) || null };
    } catch { return { lastfmReturn: null, lastfmQueued: null }; }
  });
  // the ?lastfm= note is read once; the address goes back to plain Settings › Listening
  useEffect(() => {
    if (lastfmReturn) {
      try { globalThis.history?.replaceState(globalThis.history.state, '', globalThis.location.pathname); } catch { /* keep it */ }
    }
  }, [lastfmReturn]);
  return (
    <>
      <h2>Listening</h2>
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
            phone: phone.isError || clearPhone.isError ? problem(phone.error ?? clearPhone.error, 'The player did not take the password.') : null,
            account: saveOwn.isError || removeOwn.isError ? problem(saveOwn.error ?? removeOwn.error, 'The server did not accept these details.') : null,
          }}
          onConnectLastfm={() => lastfm.mutate()}
          onConnectListenbrainz={(token) => lb.mutate(token)}
          onDisconnect={(s) => disconnect.mutate(s)}
          onSetPhonePassword={(p) => phone.mutate(p)}
          onClearPhonePassword={() => clearPhone.mutate()}
          onSaveOwnAccount={(b) => saveOwn.mutate(b)}
          onRemoveOwnAccount={() => removeOwn.mutate()}
        />
      )}
    </>
  );
}
