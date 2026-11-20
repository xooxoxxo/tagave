/**
 * Your settings › Connections (spec §4 UI): the links this
 * person made from tagave to other music apps, one group each (spec §6):
 * its state as the head's value, its address typed with one Save address,
 * what it reads (granted, not granted, or newly offered: re-link to grant),
 * the last sync and error, and Sync, Re-approve and Revoke as actions. Add
 * connection is an action, not a Save; after the first link, Link back
 * gives this tagave's address to add in the other app.
 *
 * ConnectionsPanel is the view (stories); SettingsConnectionsContent wires it.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { mcRemoteUrlSchema, type McConnectionsView, type McLinkErrorCode, type McLinkView } from '@tagave/shared';
import { Badge, Banner, Button, Input, SettingsGroup, SettingsRow, SettingsSave, confirmDialog, showToast, useSaveFlash, useSettingsDraft, type BadgeTone } from '../components/ui';
import { useAddConnection, useConnections, useEditConnectionUrl, useReapproveConnection, useRevokeConnection, useSyncConnection } from '../hooks/useConnections';
import type { ApiError } from '../services/api';
import { copyText } from './AlbumFolders';
import { shortDate } from '../utils/time';
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

const when = (iso: string) => shortDate(iso);

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
  /** Link id → a message for that link's last action (Sync, Save address, …). */
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
    <div className={styles.page}>
      {returned && 'linked' in returned && <Banner tone="success">Linked{linkedOne?.service ? ` to ${linkedOne.service}` : ''}</Banner>}
      {returned && 'error' in returned && <Banner tone="danger">{returnError(returned.error)}</Banner>}

      {links.length > 0 && (
        <ul className={styles.links} aria-label="Your connections">
          {links.map((link) => (
            <li key={link.id}>
              <LinkGroup
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
      {view && links.length === 0 && <SettingsGroup title="Your connections" meta="No connections yet" />}

      <AddConnection adding={adding} error={addError} onAdd={props.onAdd} />

      {links.length > 0 && view?.ownUrl && <LinkBack ownUrl={view.ownUrl} {...(props.onCopy ? { onCopy: props.onCopy } : {})} />}
    </div>
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
  const problem = invalid ?? error;
  return (
    <form onSubmit={submit} noValidate>
      <SettingsGroup title="Add connection" help="The address of the other music app, as you open it in a browser">
        <SettingsRow as="div" label="Address">
          <Input
            dense
            className={styles.field}
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            aria-label="App address"
            placeholder="http://music.example.com:8080"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            aria-invalid={problem ? true : undefined}
          />
          <Button type="submit" size="sm" loading={adding} disabled={!url.trim()}>Add</Button>
          {problem && <span className={styles.fieldError} role="alert">{problem}</span>}
        </SettingsRow>
      </SettingsGroup>
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
    <SettingsGroup title="Link back" help="Add this address in the other app.">
      <SettingsRow as="div" label="Address" value={<code className={styles.address}>{ownUrl}</code>}>
        <Button variant="secondary" size="sm" onClick={() => void copy()}>Copy</Button>
      </SettingsRow>
    </SettingsGroup>
  );
}

interface LinkGroupProps {
  link: McLinkView;
  busy: boolean;
  error: string | null;
  onSync: () => void;
  onReapprove: () => void;
  onEditUrl: (url: string) => Promise<boolean> | boolean;
  onRevoke: () => void;
}

const capabilityValue = (c: McLinkView['capabilities'][number]): string =>
  (c.status === 'granted' ? 'Granted' : c.status === 'available' ? 'Available' : 'Not granted') + (c.status === 'granted' && c.skipped ? ` · ${c.skipped} skipped` : '');

function LinkGroup({ link, busy, error, onSync, onReapprove, onEditUrl, onRevoke }: LinkGroupProps) {
  const base = useMemo(() => ({ url: link.remoteUrl }), [link.remoteUrl]);
  const { draft, set } = useSettingsDraft(base);
  const url = (draft ?? base).url;
  const [sending, setSending] = useState(false);
  const flash = useSaveFlash();
  const badge = stateBadge(link);
  const available = link.capabilities.filter((c) => c.status === 'available');
  const revoked = link.state === 'revoked';
  const name = link.service || 'Music app';
  const dirty = !!url.trim() && url.trim() !== link.remoteUrl;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || busy) return;
    setSending(true);
    flash.clear();
    const ok = await onEditUrl(url.trim());
    setSending(false);
    if (ok) flash.saved();
  };
  const after = (
    <>
      {link.down && (
        <Banner tone="warning">
          {link.service || 'The other app'} has not answered {link.lastSyncAt ? `since ${when(link.lastSyncAt)}` : 'since it was linked'}{link.nextAttemptAt ? ` · next try ${when(link.nextAttemptAt)}` : ''}
        </Banner>
      )}
      {link.state === 'needs_reapproval' && (
        <Banner tone="warning">The other app no longer accepts this link{link.lastError === 'needs re-approval' ? '' : ' at its new address'}. Approve it again.</Banner>
      )}
      {error && <p className={styles.errorText} role="alert">{error}</p>}
      <div className={styles.actions}>
        {revoked ? (
          <>
            <Button variant="secondary" size="sm" onClick={onReapprove} disabled={busy}>Link again</Button>
            <Button variant="quiet-danger" size="sm" onClick={onRevoke} disabled={busy}>Remove</Button>
          </>
        ) : (
          <>
            <SettingsSave type="submit" label="Save address" dirty={dirty} pending={sending} onSave={() => undefined} state={flash.state} />
            {link.state === 'active' && <Button variant="secondary" size="sm" onClick={onSync} loading={busy && !sending}>Sync</Button>}
            <Button variant={link.state === 'needs_reapproval' || available.length > 0 ? 'primary' : 'quiet'} size="sm" onClick={onReapprove} disabled={busy}>Re-approve</Button>
            <Button variant="quiet-danger" size="sm" onClick={onRevoke} disabled={busy}>Revoke</Button>
          </>
        )}
      </div>
    </>
  );
  return (
    <form onSubmit={(e) => void save(e)} noValidate>
      <SettingsGroup title={name} meta={<Badge tone={badge.tone}>{badge.label}</Badge>} after={after}>
        {revoked ? (
          <SettingsRow as="div" label="Address" value={<code className={styles.address}>{link.remoteUrl}</code>} />
        ) : (
          <SettingsRow label="Address">
            <Input dense className={styles.field} type="url" value={url} inputMode="url" spellCheck={false} onChange={(e) => set({ url: e.currentTarget.value })} />
          </SettingsRow>
        )}
        {!revoked && link.capabilities.map((c) => (
          <SettingsRow key={c.capability} as="div" label={CAPABILITY_LABELS[c.capability] ?? c.capability} value={<span className={c.status === 'granted' ? styles.value : styles.valueOff}>{capabilityValue(c)}</span>} />
        ))}
        <SettingsRow as="div" label="Synced" value={<span className={styles.value}>{link.lastSyncAt ? when(link.lastSyncAt) : 'Not yet'}</span>} />
        {link.lastError && !revoked && <SettingsRow as="div" label="Error" value={<span className={styles.errorValue}>{link.lastError}</span>} />}
        {(link.parkedDropped ?? 0) > 0 && !revoked && (
          <SettingsRow as="div" label="Not kept" value={<span className={styles.value}>{link.parkedDropped} items for albums not in your library were dropped</span>} />
        )}
        {(link.identityConflicts ?? 0) > 0 && !revoked && (
          <SettingsRow as="div" label="Disagreements" value={<span className={styles.value}>{link.identityConflicts === 1 ? 'One album ID it sent is' : `${link.identityConflicts} album IDs it sent are`} already another album’s here</span>} />
        )}
      </SettingsGroup>
    </form>
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
  // the ?linked= / ?error= note is read once; the address goes back to plain /you/connections
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
