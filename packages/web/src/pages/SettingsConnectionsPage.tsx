/**
 * Settings › Connections (Music Connections, spec §4 UI): the links this
 * person made from tagave to other music apps. Each shows what it reads
 * (granted, not granted, or newly offered: re-link to grant), the last sync,
 * the last error and its state, with Sync now, Re-approve, Edit address and
 * Revoke. An "Add connection" field starts a link; after the first one a
 * "Link back" note gives this tagave's address to add in the other app.
 *
 * ConnectionsPanel is the view (stories); SettingsConnectionsContent wires it.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { mcRemoteUrlSchema, type McConnectionsView, type McLinkErrorCode, type McLinkView } from '@tagave/shared';
import { Badge, Banner, Button, TextField, confirmDialog, showToast, type BadgeTone } from '../components/ui';
import { useAddConnection, useConnections, useEditConnectionUrl, useReapproveConnection, useRevokeConnection, useSyncConnection } from '../hooks/useConnections';
import type { ApiError } from '../services/api';
import { copyText } from './AlbumFolders';
import styles from './SettingsConnectionsPage.module.css';

const CAPABILITY_LABELS: Record<string, string> = {
  'critic-scores': 'Critic scores',
  identity: 'Which release each album is',
  'wantlist-suggestions': 'Wantlist suggestions',
};

const RETURN_ERRORS: Record<McLinkErrorCode, string> = {
  access_denied: 'The other app was not allowed to link. Nothing changed.',
  invalid_state: 'That approval expired or was already used. Start the link again.',
  remote_error: 'The other app refused to finish the link. Try again.',
  invalid_response: 'The other app answered in a way tagave does not understand. Nothing changed.',
};

/** The plain words for `?error=`; an unknown code (or "constructor") is never looked up on the prototype. */
export function returnError(code: string): string {
  return Object.hasOwn(RETURN_ERRORS, code) ? RETURN_ERRORS[code as McLinkErrorCode] : 'The link did not finish. Nothing changed.';
}

/** An action's failure in words; Sync now while a pull already waits says when it starts, or that it is syncing. */
export function problem(err: unknown, fallback: string, now = Date.now()): string {
  const e = err as (Partial<ApiError> & { retryAt?: unknown }) | null;
  const text = e?.detail || e?.title || fallback;
  if (typeof e?.retryAt !== 'string' || Number.isNaN(Date.parse(e.retryAt))) return text;
  if (Date.parse(e.retryAt) - now <= 5_000) return 'Already syncing.';
  return `${text} It starts ${when(e.retryAt)}.`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function stateBadge(link: McLinkView): { tone: BadgeTone; label: string } {
  if (link.state === 'revoked') return { tone: 'neutral', label: 'Revoked' };
  if (link.state === 'needs_reapproval') return { tone: 'warning', label: 'Needs approval' };
  if (link.down) return { tone: 'danger', label: 'Not answering' };
  if (link.failures > 0) return { tone: 'warning', label: 'Retrying' };
  return { tone: 'success', label: 'Linked' };
}

/** What `?linked=` or `?error=` said when the other app sent the browser back. */
export type ConnectionsReturn = { linked: string } | { error: string } | null;

export interface ConnectionsPanelProps {
  view: McConnectionsView | null;
  returned?: ConnectionsReturn;
  adding?: boolean;
  addError?: string | null;
  /** Link id → a message for that link's last action (Sync now, Edit address, …). */
  linkErrors?: Record<string, string>;
  busyLinkId?: string | null;
  onAdd: (url: string) => void;
  onSync: (id: string) => void;
  onReapprove: (id: string) => void;
  onEditUrl: (id: string, url: string) => Promise<boolean> | boolean;
  onRevoke: (link: McLinkView) => void;
  onCopy?: (text: string) => void;
}

export function ConnectionsPanel(props: ConnectionsPanelProps) {
  const { view, returned = null, adding = false, addError = null, linkErrors = {}, busyLinkId = null } = props;
  const links = view?.links ?? [];
  const linkedOne = returned && 'linked' in returned ? links.find((l) => l.id === returned.linked) : undefined;
  return (
    <>
      <h2>Connections</h2>

      {returned && 'linked' in returned && <Banner tone="success">Linked{linkedOne?.service ? ` to ${linkedOne.service}` : ''}</Banner>}
      {returned && 'error' in returned && <Banner tone="danger">{returnError(returned.error)}</Banner>}

      {links.length > 0 && (
        <ul className={styles.links} aria-label="Your connections">
          {links.map((link) => (
            <li key={link.id}>
              <LinkCard
                link={link}
                busy={busyLinkId === link.id}
                error={linkErrors[link.id] ?? null}
                onSync={() => props.onSync(link.id)}
                onReapprove={() => props.onReapprove(link.id)}
                onEditUrl={(url) => props.onEditUrl(link.id, url)}
                onRevoke={() => props.onRevoke(link)}
              />
            </li>
          ))}
        </ul>
      )}
      {view && links.length === 0 && <p className={styles.muted}>No connections yet</p>}

      <AddConnection adding={adding} error={addError} onAdd={props.onAdd} />

      {links.length > 0 && view?.ownUrl && <LinkBack ownUrl={view.ownUrl} {...(props.onCopy ? { onCopy: props.onCopy } : {})} />}
    </>
  );
}

/**
 * Music Connections turned off (Settings › Modules, off by default): nothing
 * links or syncs. `modules` is the way to Settings › Modules for someone who
 * may turn it on (the owner); everyone else is told to ask.
 */
export function ConnectionsOff({ modules = null }: { modules?: ReactNode }) {
  return (
    <>
      <h2>Connections</h2>
      <Banner tone="info">
        Music Connections is turned off.{' '}
        {modules ? <>Turn it on in {modules}.</> : 'Ask the owner to turn it on in Settings › Modules.'}
      </Banner>

    </>
  );
}

function AddConnection({ adding, error, onAdd }: { adding: boolean; error: string | null; onAdd: (url: string) => void }) {
  const [url, setUrl] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = mcRemoteUrlSchema.safeParse({ url });
    if (!parsed.success) { setInvalid(parsed.error.issues[0]?.message ?? 'Paste the other app’s address'); return; }
    setInvalid(null);
    onAdd(parsed.data.url);
  };
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <h3 className={styles.subTitle}>Add connection</h3>
      <TextField
        label="App address"
        type="url"
        inputMode="url"
        autoComplete="url"
        spellCheck={false}
        placeholder="http://192.168.1.20:8080"
        value={url}
        onChange={(e) => setUrl(e.currentTarget.value)}

        error={invalid ?? error ?? undefined}
      />
      <div className={styles.row}>
        <Button type="submit" loading={adding}>Link</Button>
      </div>
    </form>
  );
}

function LinkBack({ ownUrl, onCopy }: { ownUrl: string; onCopy?: (text: string) => void }) {
  const copy = async () => {
    if (onCopy) { onCopy(ownUrl); return; }
    const ok = await copyText(ownUrl);
    showToast({ message: ok ? 'Address copied' : 'Could not copy; select the address instead', tone: ok ? 'neutral' : 'danger' });
  };
  return (
    <section className={styles.linkBack} aria-labelledby="connections-link-back">
      <h3 id="connections-link-back" className={styles.subTitle}>Link back</h3>
      <p className={styles.hint}>Add this address in the other app.</p>
      <div className={styles.row}>
        <code className={styles.address}>{ownUrl}</code>
        <Button variant="secondary" size="sm" onClick={() => void copy()}>Copy</Button>
      </div>
    </section>
  );
}

interface LinkCardProps {
  link: McLinkView;
  busy: boolean;
  error: string | null;
  onSync: () => void;
  onReapprove: () => void;
  onEditUrl: (url: string) => Promise<boolean> | boolean;
  onRevoke: () => void;
}

function LinkCard({ link, busy, error, onSync, onReapprove, onEditUrl, onRevoke }: LinkCardProps) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(link.remoteUrl);
  const badge = stateBadge(link);
  const titleId = `connection-${link.id}`;
  const available = link.capabilities.filter((c) => c.status === 'available');
  const revoked = link.state === 'revoked';
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await onEditUrl(url.trim())) setEditing(false);
  };
  return (
    <article className={styles.card} aria-labelledby={titleId}>
      <header className={styles.cardHead}>
        <div className={styles.cardTitle}>
          <h3 id={titleId} className={styles.service}>{link.service || 'Music app'}</h3>
          <span className={styles.remote}>{link.remoteUrl}</span>
        </div>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </header>

      {link.down && (
        <Banner tone="warning">
          {link.service || 'The other app'} has not answered {link.lastSyncAt ? `since ${when(link.lastSyncAt)}` : 'since it was linked'}{link.nextAttemptAt ? ` · next try ${when(link.nextAttemptAt)}` : ''}
        </Banner>
      )}
      {link.state === 'needs_reapproval' && (
        <Banner tone="warning">The other app no longer accepts this link{link.lastError === 'needs re-approval' ? '' : ' at its new address'}. Approve it again.</Banner>
      )}

      {!revoked && link.capabilities.length > 0 && (
        <ul className={styles.caps} aria-label={`What tagave reads from ${link.service || 'this app'}`}>
          {link.capabilities.map((c) => (
            <li key={c.capability} className={styles.cap}>
              <span>{CAPABILITY_LABELS[c.capability] ?? c.capability}</span>
              <span className={c.status === 'granted' ? styles.capOn : styles.capOff}>
                {c.status === 'granted' ? 'Granted' : c.status === 'available' ? 'Available, re-link to grant' : 'Not granted'}
                {c.status === 'granted' && c.skipped ? ` (${c.skipped} skipped last sync)` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      <dl className={styles.meta}>
        <div><dt>Last sync</dt><dd>{link.lastSyncAt ? when(link.lastSyncAt) : 'Not yet'}</dd></div>
        {link.lastError && !revoked && <div><dt>Last error</dt><dd className={styles.errorText}>{link.lastError}</dd></div>}
        {(link.parkedDropped ?? 0) > 0 && !revoked && (
          <div><dt>Not kept</dt><dd>{link.parkedDropped} items for albums not in your library were dropped</dd></div>
        )}
        {(link.identityConflicts ?? 0) > 0 && !revoked && (
          <div><dt>Disagreements</dt><dd>{link.identityConflicts === 1 ? 'One album ID it sent is' : `${link.identityConflicts} album IDs it sent are`} already another album’s here</dd></div>
        )}
      </dl>

      {editing && (
        <form className={styles.form} onSubmit={(e) => void save(e)} noValidate>
          <TextField
            label="New address"
            type="url"
            inputMode="url"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}

          />
          <div className={styles.row}>
            <Button type="submit" variant="secondary" size="sm" loading={busy}>Save address</Button>
            <Button variant="quiet" size="sm" onClick={() => { setEditing(false); setUrl(link.remoteUrl); }}>Cancel</Button>
          </div>
        </form>
      )}
      {error && <p className={styles.errorText} role="alert">{error}</p>}

      {!editing && (
        <div className={styles.row}>
          {revoked ? (
            <>
              <Button variant="secondary" size="sm" onClick={onReapprove} disabled={busy}>Link again</Button>
              <Button variant="quiet-danger" size="sm" onClick={onRevoke} disabled={busy}>Remove</Button>
            </>
          ) : (
            <>
              {link.state === 'active' && <Button variant="secondary" size="sm" onClick={onSync} loading={busy}>Sync now</Button>}
              <Button variant={link.state === 'needs_reapproval' || available.length > 0 ? 'primary' : 'quiet'} size="sm" onClick={onReapprove} disabled={busy}>Re-approve</Button>
              <Button variant="quiet" size="sm" onClick={() => setEditing(true)}>Edit address</Button>
              <Button variant="quiet-danger" size="sm" onClick={onRevoke} disabled={busy}>Revoke</Button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

/** What the browser came back from the other app with (?linked= / ?error=), read once. */
function readReturn(): ConnectionsReturn {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    const linked = q.get('linked');
    if (linked) return { linked };
    const error = q.get('error');
    return error ? { error } : null;
  } catch {
    return null;
  }
}

export function SettingsConnectionsContent() {
  const connections = useConnections();
  const add = useAddConnection();
  const sync = useSyncConnection();
  const reapprove = useReapproveConnection();
  const edit = useEditConnectionUrl();
  const revoke = useRevokeConnection();
  const [returned] = useState(readReturn);
  const [linkErrors, setLinkErrors] = useState<Record<string, string>>({});
  const [busyLinkId, setBusy] = useState<string | null>(null);
  // the ?linked= / ?error= note is read once; the address goes back to plain Settings › Connections
  useEffect(() => {
    if (returned) {
      try { globalThis.history?.replaceState(globalThis.history.state, '', globalThis.location.pathname); } catch { /* keep it */ }
    }
  }, [returned]);

  const run = async (id: string, action: () => Promise<unknown>, fallback: string): Promise<boolean> => {
    setBusy(id);
    setLinkErrors((e) => { const { [id]: _, ...rest } = e; return rest; });
    try {
      await action();
      return true;
    } catch (err) {
      setLinkErrors((e) => ({ ...e, [id]: problem(err, fallback) }));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const onRevoke = async (link: McLinkView) => {
    const removing = link.state === 'revoked';
    const ok = await confirmDialog(removing
      ? { title: 'Remove this connection?', message: 'It goes off this list.', confirmLabel: 'Remove', tone: 'danger' }
      : { title: `Revoke the link to ${link.service || 'this app'}?`, message: 'tagave stops syncing. You can link it again later.', confirmLabel: 'Revoke', tone: 'danger' });
    if (ok) await run(link.id, () => revoke.mutateAsync(link.id), 'The connection could not be revoked.');
  };

  return (
    <>
      {connections.isError && <Banner tone="danger">Could not load your connections. {problem(connections.error, '')}</Banner>}
      <ConnectionsPanel
        view={connections.data ?? null}
        returned={returned}
        adding={add.isPending || add.isSuccess}
        addError={add.isError ? problem(add.error, 'The other app could not be linked.') : null}
        linkErrors={linkErrors}
        busyLinkId={busyLinkId}
        onAdd={(url) => add.mutate(url)}
        onSync={(id) => void run(id, async () => { await sync.mutateAsync(id); showToast({ message: 'Sync started' }); }, 'The sync could not be started.')}
        onReapprove={(id) => void run(id, () => reapprove.mutateAsync(id), 'The approval could not be started.')}
        onEditUrl={(id, url) => run(id, () => edit.mutateAsync({ id, url }), 'The address could not be changed.')}
        onRevoke={(link) => void onRevoke(link)}
      />
    </>
  );
}
