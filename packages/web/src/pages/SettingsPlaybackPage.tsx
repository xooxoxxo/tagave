/**
 * Settings › Playback: the opt-in player module. Whether a player server is
 * connected (the bundled Navidrome or one the owner already runs), a scan on
 * demand, the bring-your-own form (owner), and the quality this device asks
 * for (kept in this browser). Non-owners see the status and the quality.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { STREAM_BITRATES, savePlayerServerSchema, type PlayerCapability, type PlayerQuality, type PlayerSettingsView } from '@liner/shared';
import { Badge, Banner, Button, SegmentedControl, Select, TextField, confirmDialog, type BadgeTone } from '../components/ui';
import { useCurrentLibrary, useMe } from '../hooks';
import { useCapabilities, usePlayerQuality, usePlayerSettings, useRemovePlayerServer, useSavePlayerServer, useScanPlayer } from '../hooks/usePlayer';
import type { ApiError } from '../services/api';
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

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function SettingsPlaybackContent() {
  const { libraryId } = useCurrentLibrary();
  const { data: user } = useMe();
  const owner = user?.role === 'owner';
  const settings = usePlayerSettings(libraryId);
  const caps = useCapabilities();
  const cap = settings.data?.capability ?? caps.data?.player;
  const status = playerStatus(cap);
  const scan = useScanPlayer(libraryId);

  return (
    <>
      <h2>Playback</h2>
      <p className={styles.description}>Play albums in tagave through a Navidrome server: the one tagave can run next to itself, or one you already have. tagave streams the audio, so the server never needs to be reachable from your browser.</p>

      <div className={styles.status} role="status">
        <Badge tone={status.tone}>{status.label}</Badge>
        {status.detail && <span className={styles.statusDetail}>{status.detail}</span>}
      </div>

      {owner && cap?.installed && (
        <div className={styles.row}>
          <Button variant="secondary" size="sm" loading={scan.isPending} onClick={() => scan.mutate()}>Scan now</Button>
          <ScanLine lastScan={settings.data?.lastScan ?? null} justAsked={scan.isSuccess} />
        </div>
      )}
      {scan.isError && <p className={styles.error} role="alert">{problem(scan.error, 'The scan could not be started.')}</p>}

      {owner && settings.data?.bundled && (
        <p className={styles.hint}>Phone and desktop apps that speak Subsonic can connect to this computer on port 4533 with a Navidrome user. Create that user in Navidrome&rsquo;s own web page, on the same port.</p>
      )}

      {owner && settings.data && !settings.data.bundled && <OwnServerForm libraryId={libraryId} settings={settings.data} />}
      {owner && settings.isError && <Banner tone="danger">Could not load the playback settings. {problem(settings.error, '')}</Banner>}

      <QualitySetting />
    </>
  );
}

function ScanLine({ lastScan, justAsked }: { lastScan: PlayerSettingsView['lastScan']; justAsked: boolean }) {
  if (justAsked) return <span className={styles.muted}>Asked the server to scan.</span>;
  if (!lastScan) return null;
  if (lastScan.state === 'failed') return <span className={styles.error}>The last scan request failed{lastScan.error ? `: ${lastScan.error}` : '.'}</span>;
  return <span className={styles.muted}>Last asked {when(lastScan.requestedAt)}.</span>;
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
      message: 'tagave forgets its address, user and password, and the Play buttons go away. Nothing on the server changes.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (ok) remove.mutate(undefined, { onSuccess: () => { setUrl(''); setUsername(''); setPassword(''); } });
  };

  const hint = saved?.passwordHint ? `Saved, ends in …${saved.passwordHint}. Leave it empty to keep it.` : saved ? 'Leave it empty to keep the saved password.' : undefined;

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <h3 className={styles.subTitle}>Your own server</h3>
      <p className={styles.hint}>Any Navidrome (or other Subsonic-compatible server) that tagave&rsquo;s server can reach. It needs to see the same music folders as tagave. To run one next to tagave instead, start tagave with its &ldquo;player&rdquo; profile.</p>
      <TextField label="Server address" type="url" inputMode="url" autoComplete="url" placeholder="http://navidrome:4533" value={url} onChange={(e) => setUrl(e.currentTarget.value)} required error={invalid ?? undefined} />
      <TextField label="User name" autoComplete="username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} required />
      <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} hint={hint} />
      {save.isError && <p className={styles.error} role="alert">{problem(save.error, 'The server did not accept these details.')}</p>}
      {remove.isError && <p className={styles.error} role="alert">{problem(remove.error, 'The server could not be removed.')}</p>}
      {save.isSuccess && !save.isPending && <p className={styles.muted} role="status">Saved. tagave reached the server.</p>}
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
      <h3 className={styles.subTitle}>Quality on this device</h3>
      <p className={styles.hint}>Auto plays the original file when this browser can, and otherwise converts it to Opus, AAC or MP3 at the bitrate below. Remembered in this browser only.</p>
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
