/**
 * Settings › Playback: the opt-in player module. Whether a player server is
 * connected (the bundled Navidrome or one the owner already runs), a scan on
 * demand, the bring-your-own form (owner), Scrobbling (owner: the Last.fm
 * API key tagave signs scrobbles with), and the quality this device asks
 * for (kept in this browser). Non-owners see the status and the quality;
 * everyone's own scrobbling is in Settings › Listening.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { STREAM_BITRATES, saveLastfmAppSchema, savePlayerServerSchema, type ModulesView, type PlayerCapability, type PlayerQuality, type PlayerSettingsView, type SaveLastfmApp, type ScrobblingSettingsView } from '@tagave/shared';
import { Badge, Banner, Button, Collapse, SegmentedControl, Select, TextField, confirmDialog, type BadgeTone } from '../components/ui';
import { useCurrentLibrary, useMe } from '../hooks';
import { useModules } from '../hooks/useModules';
import { useCapabilities, usePlayerQuality, usePlayerSettings, useRemovePlayerServer, useSavePlayerServer, useScanPlayer } from '../hooks/usePlayer';
import { useModules } from '../hooks/useModules';
import { useConnectLastfm, useListening, useRemoveLastfmApp, useSaveLastfmApp, useScrobblingSettings } from '../hooks/useListening';
import type { ApiError } from '../services/api';
import { shortDate } from '../utils/time';
import styles from './SettingsPlaybackPage.module.css';

/** "navidrome" → "Navidrome" */
function backendName(backend: string | null): string {
  if (!backend) return 'the player';
  return backend.charAt(0).toUpperCase() + backend.slice(1);
}

/** The one-line status: connected, not reachable, or not set up. */
export function playerStatus(cap: PlayerCapability | null | undefined): { tone: BadgeTone; label: string; detail: string | null } {
  if (!cap) return { tone: 'neutral', label: 'Checking…', detail: null };
  if (!cap.installed) return { tone: 'neutral', label: 'Not set up', detail: null };
  if (!cap.reachable) return { tone: 'danger', label: 'Not reachable', detail: cap.error };
  const where = cap.managed === 'bundled' ? 'bundled' : 'your own server';
  return { tone: 'success', label: 'Connected', detail: `${backendName(cap.backend)}${cap.version ? ` ${cap.version}` : ''}, ${where}` };
}

/** Settings › Modules can turn the player on (a button, or the command without the updater). */
export function modulesOffersPlayer(view: ModulesView | undefined): boolean {
  if (!view || !view.verified || view.mode === 'unreachable') return false;
  return view.modules.some((m) => m.id === 'player' && m.available);
}

const problem = (err: unknown, fallback: string) => {
  const e = err as Partial<ApiError> | null;
  return e?.detail || e?.title || fallback;
};

const when = (iso: string) => shortDate(iso);

export function SettingsPlaybackContent() {
  const { libraryId } = useCurrentLibrary();
  const { data: user } = useMe();
  const owner = user?.role === 'owner';
  const settings = usePlayerSettings(libraryId);
  const caps = useCapabilities();
  const cap = settings.data?.capability ?? caps.data?.player;
  const status = playerStatus(cap);
  const scan = useScanPlayer(libraryId);
  const modules = useModules(owner && !!cap && !cap.installed);

  return (
    <>
      <h2>Playback</h2>

      <div className={styles.status} role="status">
        <Badge tone={status.tone}>{status.label}</Badge>
        {status.detail && <span className={styles.statusDetail}>{status.detail}</span>}
      </div>

      {owner && cap && !cap.installed && modulesOffersPlayer(modules.data) && (
        <p className={styles.hint}><Link to="/settings/$section" params={{ section: 'modules' }}>Turn on in Modules</Link></p>
      )}

      {owner && cap?.installed && (
        <div className={styles.row}>
          <Button variant="secondary" size="sm" loading={scan.isPending} onClick={() => scan.mutate()}>Scan</Button>
          <ScanLine lastScan={settings.data?.lastScan ?? null} justAsked={scan.isSuccess} />
        </div>
      )}
      {scan.isError && <p className={styles.error} role="alert">{problem(scan.error, 'The scan could not be started.')}</p>}

      {cap?.installed && settings.data?.bundled && (
        <p className={styles.hint}>Subsonic port 4533</p>
      )}

      {owner && settings.data && !settings.data.bundled && <OwnServerForm libraryId={libraryId} settings={settings.data} />}
      {owner && settings.isError && <Banner tone="danger">Couldn’t load playback settings. {problem(settings.error, '')}</Banner>}

      {owner && cap?.installed && <ScrobblingSettings libraryId={libraryId} />}

      <QualitySetting />
    </>
  );
}

function ScanLine({ lastScan, justAsked }: { lastScan: PlayerSettingsView['lastScan']; justAsked: boolean }) {
  if (justAsked) return <span className={styles.muted}>Scan requested</span>;
  if (!lastScan) return null;
  if (lastScan.state === 'failed') return <span className={styles.error}>Last scan failed{lastScan.error ? `: ${lastScan.error}` : ''}</span>;
  return <span className={styles.muted}>Last scan {when(lastScan.requestedAt)}</span>;
}

/** Bring your own server: address, user and password; Save tests the connection first. */
function OwnServerForm({ libraryId, settings }: { libraryId: string | undefined; settings: PlayerSettingsView }) {
  const saved = settings.external;
  const [url, setUrl] = useState(saved?.url ?? '');
  const [username, setUsername] = useState(saved?.username ?? '');
  const [password, setPassword] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const save = useSavePlayerServer(libraryId);
  const remove = useRemovePlayerServer(libraryId);
  // the saved values arrive (or change) after the first render
  useEffect(() => { setUrl(saved?.url ?? ''); setUsername(saved?.username ?? ''); }, [saved?.url, saved?.username]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const body = { url, username, ...(password ? { password } : {}) };
    const parsed = savePlayerServerSchema.safeParse(body);
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? 'Check the address and the user name.');
      return;
    }
    setInvalid(null);
    save.mutate(parsed.data, { onSuccess: () => setPassword('') });
  };

  const onRemove = async () => {
    const ok = await confirmDialog({
      title: 'Remove this player server?',
      message: 'Play buttons go away. Nothing on the server changes.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (ok) remove.mutate(undefined, { onSuccess: () => { setUrl(''); setUsername(''); setPassword(''); } });
  };

  // never any characters of the password (QA 2026-10-26 Q-36)
  const hint = saved ? 'Saved' : undefined;

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <h3 className={styles.subTitle}>Your own server</h3>

      <TextField label="Server address" type="url" inputMode="url" autoComplete="url" placeholder="http://navidrome:4533" value={url} onChange={(e) => setUrl(e.currentTarget.value)} required error={invalid ?? undefined} />
      <TextField label="User name" autoComplete="username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} required />
      <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} hint={hint} />
      {save.isError && <p className={styles.error} role="alert">{problem(save.error, 'The server did not accept these details.')}</p>}
      {remove.isError && <p className={styles.error} role="alert">{problem(remove.error, 'The server could not be removed.')}</p>}
      {save.isSuccess && !save.isPending && <p className={styles.muted} role="status">Connected</p>}
      <div className={styles.row}>
        <Button type="submit" loading={save.isPending}>Save</Button>
        {saved && <Button variant="quiet-danger" onClick={() => void onRemove()} disabled={remove.isPending}>Remove</Button>}
      </div>
    </form>
  );
}

const FORMATS: Array<{ value: PlayerQuality['format']; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'original', label: 'Original' },
  { value: 'opus', label: 'Opus' },
  { value: 'aac', label: 'AAC' },
  { value: 'mp3', label: 'MP3' },
];

/** The quality this device asks for, in this browser's storage. */
function QualitySetting() {
  const [quality, setQuality] = usePlayerQuality();
  return (
    <>
      <h3 className={styles.subTitle}>Quality</h3>
      <div className={styles.quality}>
        <SegmentedControl label="Format" value={quality.format} onChange={(format) => setQuality({ format })} options={FORMATS} />
        <label className={styles.bitrate}>
          <span className={styles.bitrateLabel}>Bitrate</span>
          <Select
            dense
            value={String(quality.bitrate)}
            disabled={quality.format === 'original'}
            onChange={(e) => setQuality({ bitrate: Number(e.currentTarget.value) })}
          >
            {STREAM_BITRATES.map((b) => <option key={b} value={b}>{b} kbps</option>)}
          </Select>
        </label>
      </div>
    </>
  );
}

// ---- Scrobbling (owner) ----

function ScrobblingSettings({ libraryId }: { libraryId: string | undefined }) {
  const view = useScrobblingSettings(libraryId, true);
  const save = useSaveLastfmApp(libraryId);
  const remove = useRemoveLastfmApp(libraryId);
  const listening = useListening();
  const connect = useConnectLastfm();
  const onRemove = async () => {
    const ok = await confirmDialog({
      title: 'Remove the Last.fm API key?',
      message: 'Last.fm scrobbles wait until a key is added again.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (ok) remove.mutate();
  };
  if (view.isError) return <Banner tone="danger">Could not load the scrobbling settings. {problem(view.error, '')}</Banner>;
  const mine = listening.data;
  const lastfm = mine?.services.find((s) => s.service === 'lastfm');
  return (
    <ScrobblingSettingsPanel
      view={view.data ?? null}
      saving={save.isPending}
      saved={save.isSuccess && !save.isPending}
      error={save.isError ? problem(save.error, 'Last.fm did not accept these.') : remove.isError ? problem(remove.error, 'The key could not be removed.') : null}
      onSave={(body) => save.mutate(body)}
      onRemove={() => void onRemove()}
      you={mine && !mine.account.serverScrobbles ? { lastfmAccount: lastfm?.connected ? lastfm.accountName ?? '' : null } : null}
      connecting={connect.isPending}
      connectError={connect.isError ? problem(connect.error, 'Last.fm could not be reached.') : null}
      onConnect={() => connect.mutate()}
    />
  );
}

export interface ScrobblingSettingsPanelProps {
  view: ScrobblingSettingsView | null;
  saving?: boolean;
  saved?: boolean;
  error?: string | null;
  onSave: (body: SaveLastfmApp) => void;
  onRemove: () => void;
  /** the signed-in person's own Last.fm: their account name, or null when not connected; null/absent hides the line */
  you?: { lastfmAccount: string | null } | null;
  connecting?: boolean;
  connectError?: string | null;
  onConnect?: () => void;
  /** stories: start with the Replace form open */
  initialReplacing?: boolean;
}

/** The owner's half of scrobbling: the Last.fm application, and whether the owner's own Last.fm is connected. */
export function ScrobblingSettingsPanel({
  view, saving = false, saved = false, error = null, onSave, onRemove, you = null, connecting = false, connectError = null, onConnect, initialReplacing = false,
}: ScrobblingSettingsPanelProps) {
  const lastfm = view?.lastfm;
  const configured = !!lastfm?.configured;
  const [replacing, setReplacing] = useState(initialReplacing);
  useEffect(() => { if (saved) setReplacing(false); }, [saved]);
  return (
    <section className={styles.scrobbling} aria-labelledby="playback-scrobbling">
      <h3 id="playback-scrobbling" className={styles.subTitle}>Scrobbling</h3>
      {!view ? <p className={styles.muted}>Loading…</p> : configured && !replacing ? (
        <>
          <div className={styles.keyLine}>
            <span className={styles.keyText}>Last.fm · API key …{lastfm?.apiKeyHint}{lastfm?.source === 'env' ? ' · from .env' : ''}</span>
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.row}>
            <Button variant="secondary" size="sm" onClick={() => setReplacing(true)}>Replace</Button>
            {lastfm?.source === 'settings' && <Button variant="quiet-danger" size="sm" onClick={onRemove} disabled={saving}>Remove</Button>}
          </div>
        </>
      ) : (
        <LastfmKeyForm replacing={configured} saving={saving} saved={saved} error={error} onSave={onSave} onCancel={() => setReplacing(false)} />
      )}
      {configured && you && (you.lastfmAccount !== null ? (
        <p className={styles.hint}>Your Last.fm: {you.lastfmAccount}</p>
      ) : (
        <div className={styles.youLine}>
          <span className={styles.youText}>Your Last.fm</span>
          <Button size="sm" loading={connecting} onClick={onConnect}>Connect</Button>
          {connectError && <p className={styles.error} role="alert">{connectError}</p>}
        </div>
      ))}
    </section>
  );
}

function LastfmKeyForm({ replacing, saving, saved, error, onSave, onCancel }: { replacing: boolean; saving: boolean; saved: boolean; error: string | null; onSave: (body: SaveLastfmApp) => void; onCancel: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const [howOpen, setHowOpen] = useState(false);
  useEffect(() => { if (saved) { setApiKey(''); setSecret(''); } }, [saved]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = saveLastfmAppSchema.safeParse({ apiKey, secret });
    if (!parsed.success) { setInvalid(parsed.error.issues[0]?.message ?? 'Check both values.'); return; }
    setInvalid(null);
    onSave(parsed.data);
  };
  return (
    <form className={styles.form} onSubmit={submit} noValidate>

      <div>
        <Button variant="quiet" size="sm" aria-expanded={howOpen} aria-controls="lastfm-key-steps" onClick={() => setHowOpen((o) => !o)}>How to</Button>
        <Collapse open={howOpen} id="lastfm-key-steps">
          <ol className={styles.steps}>
            <li>Open <a href="https://www.last.fm/api/account/create" target="_blank" rel="noreferrer">last.fm/api/account/create</a> and sign in.</li>
            <li>Enter any application name; leave the other fields empty.</li>
            <li>Submit, then copy the API key and shared secret here.</li>
          </ol>
        </Collapse>
      </div>
      <TextField label="API key" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.currentTarget.value)} />
      <TextField label="Shared secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.currentTarget.value)} error={invalid ?? error ?? undefined} />
      <div className={styles.row}>
        <Button type="submit" loading={saving} disabled={!apiKey || !secret}>Save</Button>
        {replacing && <Button variant="quiet" onClick={onCancel} disabled={saving}>Cancel</Button>}
      </div>
    </form>
  );
}
