/**
 * Settings › Modules › Player, the owner's part, after its Module group:
 * Player server (whether one is connected, the bundled Navidrome or one
 * the owner already runs, and a scan on demand), Your own server (address,
 * user and password, one Save that tests then connects), Quality (what
 * this device asks for, kept in this browser, applied at once) and
 * Scrobbling (the Last.fm API key and shared secret tagave signs scrobbles
 * with: a secret pair with its own Save, Replace and Forget). Quality and
 * Scrobbling show only while a player server answers. Each person's own
 * account and scrobbling live in Your settings › Listening.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { STREAM_BITRATES, saveLastfmAppSchema, savePlayerServerSchema, type PlayerCapability, type PlayerQuality, type PlayerSettingsView, type SaveLastfmApp, type ScrobblingSettingsView } from '@tagave/shared';
import { Badge, Banner, Button, Input, SaveStatus, SegmentedControl, Select, SettingsGroup, SettingsRow, SettingsSave, confirmDialog, type BadgeTone } from '../components/ui';
import { useCurrentLibrary, useMe } from '../hooks';
import { useCapabilities, usePlayerQuality, usePlayerSettings, useRemovePlayerServer, useSavePlayerServer, useScanPlayer } from '../hooks/usePlayer';
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
  const installed = !!cap?.installed;

  return (
    <>
      <SettingsGroup
        title="Player server"
        help={installed && settings.data?.bundled ? 'Phone and desktop apps reach the bundled player on Subsonic port 4533' : null}
        after={owner && settings.isError ? <Banner tone="danger">Couldn’t load playback settings. {problem(settings.error, '')}</Banner> : null}
      >
        <SettingsRow as="div" label="Connection" value={<span className={styles.values} role="status">
          <Badge tone={status.tone}>{status.label}</Badge>
          {status.detail && <span className={styles.value}>{status.detail}</span>}
        </span>} />
        {owner && installed && (
          <SettingsRow as="div" label="Last scan" value={<ScanValue lastScan={settings.data?.lastScan ?? null} justAsked={scan.isSuccess} error={scan.isError ? problem(scan.error, 'The scan could not be started.') : null} />}>
            <Button variant="secondary" size="sm" loading={scan.isPending} onClick={() => scan.mutate()}>Scan</Button>
          </SettingsRow>
        )}
      </SettingsGroup>

      {owner && settings.data && !settings.data.bundled && <OwnServerForm libraryId={libraryId} settings={settings.data} />}

      {installed && <QualitySetting />}

      {owner && installed && <ScrobblingSettings libraryId={libraryId} />}
    </>
  );
}

function ScanValue({ lastScan, justAsked, error }: { lastScan: PlayerSettingsView['lastScan']; justAsked: boolean; error: string | null }) {
  if (error) return <span className={styles.danger} role="alert">{error}</span>;
  if (justAsked) return <span className={styles.value} role="status">Requested</span>;
  if (!lastScan) return <span className={styles.value}>None yet</span>;
  if (lastScan.state === 'failed') return <span className={styles.danger}>Failed{lastScan.error ? `: ${lastScan.error}` : ''}</span>;
  return <span className={styles.value}>{when(lastScan.requestedAt)}</span>;
}

/** Bring your own server: address, user and password; one Save, which tests the connection first. */
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
  const dirty = url !== (saved?.url ?? '') || username !== (saved?.username ?? '') || !!password;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || save.isPending) return;
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

  const failed = invalid ?? (save.isError ? problem(save.error, 'The server did not accept these details.') : remove.isError ? problem(remove.error, 'The server could not be removed.') : null);

  return (
    <form onSubmit={onSubmit} noValidate>
      <SettingsGroup
        title="Your own server"
        help="A Navidrome or other Subsonic server you already run"
        after={(
          <div className={`${styles.actions} ${styles.footer}`}>
            <SettingsSave type="submit" dirty={dirty} pending={save.isPending} state={failed ? 'failed' : null} detail={failed} onSave={() => undefined} />
            {save.isSuccess && !save.isPending && !dirty && <span className={styles.value} role="status">Connected</span>}
            {saved && <Button size="sm" variant="quiet-danger" onClick={() => void onRemove()} disabled={remove.isPending}>Remove</Button>}
          </div>
        )}
      >
        <SettingsRow label="Server address">
          <Input dense className={styles.field} type="url" inputMode="url" autoComplete="url" placeholder="http://navidrome:4533" value={url} onChange={(e) => setUrl(e.currentTarget.value)} required aria-invalid={invalid ? true : undefined} />
        </SettingsRow>
        <SettingsRow label="User name">
          <Input dense className={styles.field} autoComplete="username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} required />
        </SettingsRow>
        {/* never any characters of the password (QA 2026-10-26 Q-36) */}
        <SettingsRow label="Password" value={<span className={styles.value}>{saved ? 'Set' : 'Not set'}</span>}>
          <Input dense className={styles.field} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
        </SettingsRow>
      </SettingsGroup>
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

/** The quality this device asks for, in this browser's storage: applied at once, nothing to save on the server. */
function QualitySetting() {
  const [quality, setQuality] = usePlayerQuality();
  return (
    <SettingsGroup title="Quality" help="What this device asks the player for, kept in this browser">
      <SettingsRow as="div" label="Format">
        <SegmentedControl label="Format" value={quality.format} onChange={(format) => setQuality({ format })} options={FORMATS} />
      </SettingsRow>
      <SettingsRow label="Bitrate">
        <Select
          dense
          value={String(quality.bitrate)}
          disabled={quality.format === 'original'}
          onChange={(e) => setQuality({ bitrate: Number(e.currentTarget.value) })}
        >
          {STREAM_BITRATES.map((b) => <option key={b} value={b}>{b} kbps</option>)}
        </Select>
      </SettingsRow>
    </SettingsGroup>
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
      title: 'Forget the Last.fm API key?',
      message: 'Last.fm scrobbles wait until a key is added again.',
      confirmLabel: 'Forget',
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
  /** Forget the stored key (only one saved here, not one from .env) */
  onRemove: () => void;
  /** the signed-in person's own Last.fm: their account name, or null when not connected; null/absent hides the row */
  you?: { lastfmAccount: string | null } | null;
  connecting?: boolean;
  connectError?: string | null;
  onConnect?: () => void;
  /** stories: start with the Replace fields open */
  initialReplacing?: boolean;
}

const KEY_STEPS = (
  <ol className={styles.steps}>
    <li>Open <a href="https://www.last.fm/api/account/create" target="_blank" rel="noreferrer">last.fm/api/account/create</a> and sign in.</li>
    <li>Enter any application name; leave the other fields empty.</li>
    <li>Submit, then copy the API key and shared secret here.</li>
  </ol>
);

/**
 * The owner's half of scrobbling: the Last.fm application (a secret pair:
 * API key and shared secret, with its own Save, Replace and Forget), and
 * whether the owner's own Last.fm is connected.
 */
export function ScrobblingSettingsPanel({
  view, saving = false, saved = false, error = null, onSave, onRemove, you = null, connecting = false, connectError = null, onConnect, initialReplacing = false,
}: ScrobblingSettingsPanelProps) {
  const lastfm = view?.lastfm;
  const configured = !!lastfm?.configured;
  const [replacing, setReplacing] = useState(initialReplacing);
  useEffect(() => { if (saved) setReplacing(false); }, [saved]);
  const editing = !!view && (!configured || replacing);
  return (
    <SettingsGroup title="Scrobbling" help={KEY_STEPS} status={!editing && error ? <SaveStatus state="failed" detail={error} /> : null}>
      {!view ? <SettingsRow as="div" label="Last.fm" value={<span className={styles.value}>Loading</span>} /> : editing ? (
        <LastfmKeyFields replacing={configured} saving={saving} saved={saved} error={error} onSave={onSave} onCancel={() => setReplacing(false)} />
      ) : (
        <SettingsRow as="div" label="Last.fm" value={<span className={styles.value}>Set · ••••{lastfm?.apiKeyHint}{lastfm?.source === 'env' ? ' · from .env' : ''}</span>}>
          <span className={styles.actions}>
            <Button variant="secondary" size="sm" onClick={() => setReplacing(true)}>Replace</Button>
            {lastfm?.source === 'settings' && <Button variant="quiet-danger" size="sm" onClick={onRemove} disabled={saving}>Forget</Button>}
          </span>
        </SettingsRow>
      )}
      {configured && you && (
        <SettingsRow
          as="div"
          label="Your Last.fm"
          value={you.lastfmAccount !== null
            ? <span className={styles.value}>Connected · {you.lastfmAccount}</span>
            : connectError ? <span className={styles.danger} role="alert">{connectError}</span> : <span className={styles.value}>Not connected</span>}
        >
          {you.lastfmAccount === null && <Button size="sm" loading={connecting} onClick={onConnect}>Connect</Button>}
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

/** The API key and shared secret, sent together with their own Save (never part of another Save). */
function LastfmKeyFields({ replacing, saving, saved, error, onSave, onCancel }: { replacing: boolean; saving: boolean; saved: boolean; error: string | null; onSave: (body: SaveLastfmApp) => void; onCancel: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  useEffect(() => { if (saved) { setApiKey(''); setSecret(''); } }, [saved]);
  const send = () => {
    const parsed = saveLastfmAppSchema.safeParse({ apiKey, secret });
    if (!parsed.success) { setInvalid(parsed.error.issues[0]?.message ?? 'Check both values.'); return; }
    setInvalid(null);
    onSave(parsed.data);
  };
  const failed = invalid ?? error;
  return (
    <>
      <SettingsRow label="API key">
        <Input dense className={styles.field} autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.currentTarget.value)} />
      </SettingsRow>
      <SettingsRow label="Shared secret">
        <Input dense className={styles.field} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && apiKey && secret) { e.preventDefault(); send(); } }} />
      </SettingsRow>
      <SettingsRow as="div" label="Last.fm app" value={failed ? <SaveStatus state="failed" detail={failed} /> : null}>
        <span className={styles.actions}>
          <SettingsSave dirty={!!apiKey && !!secret} pending={saving} onSave={send} />
          {replacing && <Button size="sm" variant="quiet" onClick={onCancel} disabled={saving}>Cancel</Button>}
        </span>
      </SettingsRow>
    </>
  );
}
