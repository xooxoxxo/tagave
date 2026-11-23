/**
 * Settings › Updates (spec PLT-5, XO-313): whether a newer release exists
 * and what it changes, the update steps for the way this server was
 * installed (that one first, the others folded away), what is running where
 * (app vs workers, with a warning for a host on an older build), and the update-check
 * switch. The server checks the official release feed on its own at most
 * every 12 hours. With the opt-in updater installed, the page also starts
 * an update and follows it (InAppUpdate); without it, it shows the command.
 * Groups under the frame's one heading (spec §6): What’s new, the update,
 * Running now, Update checks. Update checks is Off | On and saves when
 * changed; the feed URL saves with its own Save. Release notes and the
 * guide's steps are content, under their group's head.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { docsUrl } from '../utils/docs';
import ReactMarkdown from 'react-markdown';
import type { BuildInfoView, InstallMethod, ReleaseNote, UpdatesStatus, WorkerVersion } from '@tagave/shared';
import { useCurrentLibrary } from '../hooks';
import { useCheckUpdates, useSetUpdatesFeed, useSkipUpdate, useUpdates } from '../hooks/useUpdates';
import { restartingOn, useUpdater, type SeenUpdaterView } from '../hooks/useUpdater';
import { InAppUpdate, RunView, useNow, useShownRun } from '../components/InAppUpdate';
import { Banner, Button, Input, SaveStatus, SegmentedControl, SettingsGroup, SettingsRow, SettingsSave, useSaveFlash, useSettingsDraft, type SaveState } from '../components/ui';
import { attentionReleases, guideOrder, rollbackGuide, updateGuide, type RollbackGuide } from '../utils/updateGuide';
import { shortDate } from '../utils/time';
import styles from './SettingsUpdatesPage.module.css';

/** "11 Oct, 19:29", the app's date format; the year only when it is not this one; Unknown when there is none. */
function when(iso: string | null | undefined): string {
  return iso ? shortDate(iso) : 'Unknown';
}
/** "now" under a minute, then "2 min ago", "3 h ago". */
function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return when(iso);
}
function fullDate(iso: string | null | undefined): string | undefined {
  return iso ? new Date(iso).toLocaleString() : undefined;
}
function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : 'Unknown';
}
function workerName(w: WorkerVersion): string {
  return w.host ?? w.workerId.replace(/^worker-/, '');
}
const SOURCE: Record<UpdatesStatus['app']['source'], string> = {
  env: 'image build arguments',
  'deployed-file': 'the DEPLOYED file',
  git: 'the git checkout',
  unknown: 'an unknown source',
};

/** A worker's queues by the kind of work, in the order the owner reads them; the full list is the cell's title. */
const WORK: Array<[string, RegExp]> = [
  ['folders', /^(scan|roots|cluster)\./],
  ['identify', /^(identify|fingerprint|acoustid|edition)\.|^queue\.autoaccept$/],
  ['details', /^(enrich|editions|art|reviews|artists?|tracks|gaps)\./],
  ['tags', /^tags\./],
  ['Discogs', /^collection\./],
];
export function workOf(queues: string[]): string {
  if (queues.includes('*')) return 'all';
  if (queues.length === 0) return 'None';
  const kinds = new Set(queues.map((q) => WORK.find(([, re]) => re.test(q))?.[0] ?? 'upkeep'));
  return [...WORK.map(([k]) => k), 'upkeep'].filter((k) => kinds.has(k)).join(', ');
}

/**
 * How long after an update ends (or the app comes back on a new build) a
 * worker on another build is taken as still restarting, not as left behind.
 */
export const SETTLE_MS = 2 * 60_000;

/**
 * An update is under way or has just ended: the updater runs one, restarts
 * itself, or finished one under two minutes ago, or this page saw the app
 * come back on a new build under two minutes ago (an update by hand).
 */
export function updatingNow(view: SeenUpdaterView | undefined, appChangedAt: number | null, now = Date.now()): boolean {
  const run = view?.updater?.run ?? null;
  if (run?.status === 'running' || restartingOn(view, now)) return true;
  if (run?.finishedAt && now - Date.parse(run.finishedAt) < SETTLE_MS) return true;
  return appChangedAt !== null && now - appChangedAt < SETTLE_MS;
}

/** When this page saw the app's build change (null until it does). */
function useAppChangedAt(sha: string | null): number | null {
  const first = useRef(sha);
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    if (sha !== first.current) {
      first.current = sha;
      setAt(Date.now());
    }
  }, [sha]);
  return at;
}

/** A worker's build next to the app's: the same, still updating, or older. */
export function workerBuild(w: WorkerVersion, app: BuildInfoView, updating: boolean): 'same' | 'updating' | 'older' {
  if (!w.sha || !app.sha || w.sha === app.sha) return 'same';
  return updating ? 'updating' : 'older';
}

/** Running now: the app and every worker, with their builds. */
export function RunningNow({ app, workers, updating, now = Date.now() }: { app: BuildInfoView; workers: WorkerVersion[]; updating: boolean; now?: number }) {
  return (
    // seven columns never fit a phone; the table scrolls inside its own box
    // instead of pushing the whole page sideways
    <div className={styles.tableScroll} role="region" aria-label="Running now" tabIndex={0}>
    <table className={styles.table}>
      <thead>
        <tr><th>Process</th><th>Version</th><th>Build</th><th>Built</th><th>Queues</th><th>Last seen</th><th>Loop lag</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>App</strong></td>
          <td>{app.version}</td>
          <td title={`${app.sha ?? 'No build id'}, read from ${SOURCE[app.source]}`}><code>{shortSha(app.sha)}</code></td>
          <td title={fullDate(app.builtAt)}>{when(app.builtAt)}</td>
          <td className={styles.dim}>web + API</td>
          <td className={styles.dim}>now</td>
          <td className={styles.dim}>Not measured</td>
        </tr>
        {workers.length === 0 && (
          <tr><td colSpan={7} className={styles.dim}>No workers seen</td></tr>
        )}
        {workers.map((w) => {
          const build = workerBuild(w, app, updating);
          return (
            <tr key={w.workerId} className={build === 'older' ? styles.rowWarn : undefined}>
              <td><strong>Worker</strong> <span className={styles.dim}>{workerName(w)}</span></td>
              <td>{w.version ?? 'Unknown'}</td>
              <td title={w.sha ?? undefined}>
                <code>{shortSha(w.sha)}</code>
                {build === 'older' && <span className={styles.attention}>Older build</span>}
                {build === 'updating' && <span className={styles.updating}>Updating</span>}
              </td>
              <td title={fullDate(w.builtAt)}>{when(w.builtAt)}</td>
              <td className={styles.queues} title={w.queues.join(', ')}>{workOf(w.queues)}</td>
              <td title={fullDate(w.lastSeenAt)}>{ago(w.lastSeenAt, now)}</td>
              <td className={w.loopLagMs != null && w.loopLagMs > 5000 ? styles.attentionText : undefined}>
                {w.loopLagMs != null ? `${w.loopLagMs} ms` : 'Not measured'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

function GuideSteps({ guide }: { guide: RollbackGuide }) {
  return (
    <>
      <p className={styles.hint}>{guide.intro}</p>
      {guide.steps.map((step, i) => (
        <div key={i}>
          {step.text && <p className={styles.hint}>{step.text}</p>}
          {step.command && <pre className={styles.code}>{step.command}</pre>}
        </div>
      ))}
    </>
  );
}

function ReleaseArticle({ release, open }: { release: ReleaseNote; open: boolean }) {
  return (
    <details className={styles.release} open={open}>
      <summary className={styles.releaseHead}>
        <strong>{release.tag}</strong>
        {release.name && release.name !== release.tag && release.name.replace(/^tagave\s+/i, 'v') !== release.tag && <span>{release.name}</span>}
        {release.publishedAt && <span className={styles.muted}>{new Date(release.publishedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>}
        {release.requiresAttention && <span className={styles.attention}>requires attention</span>}
      </summary>
      <div className={styles.markdown}>
        {release.body ? <ReactMarkdown>{release.body}</ReactMarkdown> : <p className={styles.muted}>No release notes.</p>}
        {release.url && <p><a href={release.url} target="_blank" rel="noreferrer">Release page ↗</a></p>}
      </div>
    </details>
  );
}

/** A save's progress and outcome. */
export interface UpdatesSave {
  pending?: boolean;
  state?: SaveState;
  detail?: string | null;
}

export interface UpdateChecksViewProps {
  feed: UpdatesStatus['feed'];
  /** the feed URL's draft; empty: the official feed */
  url: string;
  onUrl: (url: string) => void;
  onEnabled: (on: boolean) => void;
  onSaveUrl: (url: string | null) => void;
  onCheck: () => void;
  checking?: boolean;
  enabledStatus?: UpdatesSave;
  urlStatus?: UpdatesSave;
}

const ON_OFF = (disabled: boolean) => [{ value: 'off' as const, label: 'Off', disabled }, { value: 'on' as const, label: 'On', disabled }];

/** Update checks: Off | On (saved when changed), the last check with Check now, the feed URL with its Save. */
export function UpdateChecksView({ feed, url, onUrl, onEnabled, onSaveUrl, onCheck, checking = false, enabledStatus = {}, urlStatus = {} }: UpdateChecksViewProps) {
  const typed = url.trim();
  const dirty = typed !== (feed.custom ? feed.url ?? '' : '');
  const last = feed.lastCheckedAt ? <span title={fullDate(feed.lastCheckedAt)}>{when(feed.lastCheckedAt)}</span> : 'Not checked yet';
  return (
    <SettingsGroup
      title="Update checks"
      help="The server checks the release feed on its own at most every 12 hours"
      status={<SaveStatus state={enabledStatus.state ?? null} detail={enabledStatus.detail ?? null} />}
    >
      {feed.lockedByServer ? (
        <SettingsRow as="div" label="Update checks" help="Set on the server" value={<span className={styles.value}>{feed.enabled ? <><code>TAGAVE_UPDATE_FEED</code> · <code>{feed.url}</code></> : <>Off · <code>TAGAVE_UPDATE_FEED=off</code></>}</span>} />
      ) : (
        <SettingsRow as="div" label="Update checks">
          <SegmentedControl label="Update checks" value={feed.enabled ? 'on' : 'off'} onChange={(v) => { if (!enabledStatus.pending) onEnabled(v === 'on'); }} options={ON_OFF(!!enabledStatus.pending)} />
        </SettingsRow>
      )}
      {feed.enabled && (
        <SettingsRow as="div" label="Last check" value={<span className={feed.error ? styles.danger : styles.value}>{last}{feed.error ? ` · Failed: ${feed.error}` : ''}</span>}>
          <Button variant="secondary" size="sm" loading={checking} onClick={onCheck}>Check now</Button>
        </SettingsRow>
      )}
      {!feed.lockedByServer && feed.enabled && (
        <SettingsRow as="div" label="Feed" help="A GitHub releases API URL; empty for the official feed">
          <span className={styles.control}>
            <Input
              dense
              className={styles.input}
              aria-label="Feed"
              placeholder={feed.defaultUrl}
              spellCheck={false}
              value={url}
              onChange={(e) => onUrl(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && dirty) { e.preventDefault(); onSaveUrl(typed || null); } }}
            />
            <SettingsSave dirty={dirty} pending={!!urlStatus.pending} state={urlStatus.state ?? null} detail={urlStatus.detail ?? null} onSave={() => onSaveUrl(typed || null)} />
          </span>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

export function SettingsUpdatesPage() {
  const { libraryId } = useCurrentLibrary();
  const { data, isLoading } = useUpdates(libraryId);
  if (isLoading) return <p className={styles.muted}>Loading…</p>;
  // A failed refetch keeps the last answer: during an in-app update the app
  // restarts and this page must stay put.
  if (!data) return <Banner tone="danger">Could not load update status.</Banner>;
  return <UpdatesContent data={data} libraryId={libraryId} />;
}

function UpdatesContent({ data, libraryId }: { data: UpdatesStatus; libraryId: string | undefined }) {
  const setFeed = useSetUpdatesFeed(libraryId);
  const check = useCheckUpdates(libraryId);
  const skip = useSkipUpdate(libraryId);
  const updater = useUpdater();
  const { app, workers, feed, install } = data;
  const target = feed.newer[0] ?? null;
  const attention = attentionReleases(feed.newer);
  const [readFor, setReadFor] = useState<string | null>(null);
  const confirmed = attention.length === 0 || readFor === target?.version;
  const feedBase = useMemo(() => ({ url: feed.custom ? feed.url ?? '' : '' }), [feed.custom, feed.url]);
  const feedDraft = useSettingsDraft(feedBase);
  const enabledFlash = useSaveFlash();
  const urlFlash = useSaveFlash();
  const [feedPending, setFeedPending] = useState<'enabled' | 'url' | null>(null);
  const saveFeed = async (which: 'enabled' | 'url', body: { enabled: boolean } | { url: string | null }) => {
    const flash = which === 'enabled' ? enabledFlash : urlFlash;
    flash.clear();
    setFeedPending(which);
    try {
      await setFeed.mutateAsync(body);
      flash.saved();
    } catch {
      flash.failed(which === 'url' ? 'Use a GitHub releases API URL' : null);
    } finally {
      setFeedPending(null);
    }
  };

  const detected: InstallMethod = install.method;
  const [primary, ...others] = guideOrder(detected).map((m) => updateGuide(m, install, target?.version ?? null));
  const skipped = target && feed.skippedVersion && !data.updateAvailable;
  const uv = updater.data;
  // A run keeps the in-app view up while the app restarts and cannot answer.
  const inApp = !!uv?.installed && (uv.reachable || !!uv.updater?.run);
  const disconnected = !!updater.error || (!!uv?.installed && !uv.reachable);
  // "Up to date" only when a check actually ran and found nothing newer.
  const upToDate = feed.enabled && !!feed.lastCheckedAt && !feed.error && feed.newer.length === 0;
  const shown = useShownRun(uv);
  const appChangedAt = useAppChangedAt(app.sha);
  // ticks only while an update settles, so Updating turns into Older build on time
  const [ticking, setTicking] = useState(false);
  const tick = useNow(ticking);
  const current = ticking ? tick : Date.now();
  const updating = updatingNow(uv, appChangedAt, current);
  useEffect(() => { setTicking(updating); }, [updating]);

  // While a run is on screen it is the whole pane (the section list steps aside).
  if (inApp && shown.run) {
    return <RunView run={shown.run} disconnected={disconnected} reloading={shown.reloading} restart={shown.restart} onDismiss={shown.dismiss} />;
  }

  const manual = confirmed ? (
      <div className={styles.guide}>
        <p className={styles.guideTitle}>
          <strong>{primary!.title}</strong>
          {detected !== 'unknown' && <span className={styles.detected}>this server</span>}
        </p>
        <GuideSteps guide={primary!} />
        <details className={styles.more}>
          <summary>Roll back</summary>
          <GuideSteps guide={rollbackGuide(primary!.method, install, app.version, target?.version ?? null)} />
        </details>
        {others.map((g) => (
          <details key={g.method} className={styles.more}>
            <summary>{g.title}</summary>
            <GuideSteps guide={g} />
          </details>
        ))}
      </div>
    ) : (
      <p className={styles.muted}>Read the notes first</p>
    );

  return (
    <>
    <div className={styles.page}>
      {target && data.updateAvailable && (
        <Banner tone="info">
          <div className={styles.bannerRow}>
            <span><strong>tagave {target.version}</strong> · you run {app.version}</span>
            {target.requiresAttention && <span className={styles.attention}>requires attention</span>}
            <Button size="sm" variant="quiet" className={styles.bannerAction} disabled={skip.isPending} onClick={() => skip.mutate(target.version)}>
              Skip
            </Button>
          </div>
        </Banner>
      )}
      {skipped && (
        <p className={styles.muted}>
          Skipped {feed.skippedVersion}{' '}
          <Button size="sm" variant="quiet" disabled={skip.isPending} onClick={() => skip.mutate(null)}>Show it again</Button>
        </p>
      )}
      {data.mismatch && !updating && (
        <Banner tone="warning">A worker runs a different build than the app.</Banner>
      )}

      {feed.newer.length > 0 && (
        <SettingsGroup title="What’s new" after={feed.newer.map((r) => <ReleaseArticle key={r.tag} release={r} open={r.requiresAttention || r === target} />)} />
      )}

      <SettingsGroup
        title={inApp ? 'Update this server' : target ? `Update to ${target.version}` : 'How to update'}
        meta={!inApp && !target && upToDate ? `Up to date · ${app.version}` : null}
        after={<>
          {attention.length > 0 && target && (
            <Banner tone="warning">
              <p className={styles.gateText}>
                {attention.length === 1 ? attention[0]!.tag : attention.map((r) => r.tag).join(', ')}{' '}<strong>requires attention</strong>
              </p>
              <label className={styles.gateCheck}>
                <input type="checkbox" checked={confirmed} onChange={(e) => setReadFor(e.target.checked ? target.version : null)} />
                I have read the notes
              </label>
            </Banner>
          )}
          {inApp && uv ? (
            <>
              <InAppUpdate view={uv} disconnected={disconnected} current={app.version} releases={feed.newer} confirmed={confirmed} upToDate={upToDate} />
              <details className={styles.more}>
                <summary>Update by hand</summary>
                {manual}
              </details>
            </>
          ) : (
            <>
              {uv?.installed && !uv.reachable && (
                <Banner tone="warning">
                  The updater does not answer ({uv.error}).
                </Banner>
              )}
              {manual}
              {uv && !uv.installed && (
                <a className={styles.hint} href={docsUrl('install.md#updating-from-the-app-optional-updater')} target="_blank" rel="noreferrer">Update from this page</a>
              )}
            </>
          )}
        </>}
      />

      <SettingsGroup title="Running now" after={<RunningNow app={app} workers={workers} updating={updating} now={current} />} />

      <UpdateChecksView
        feed={feed}
        url={feedDraft.draft?.url ?? ''}
        onUrl={(url) => feedDraft.set({ url })}
        onEnabled={(enabled) => void saveFeed('enabled', { enabled })}
        onSaveUrl={(url) => void saveFeed('url', { url })}
        onCheck={() => check.mutate()}
        checking={check.isPending}
        enabledStatus={{ pending: feedPending === 'enabled', state: enabledFlash.state, detail: enabledFlash.detail }}
        urlStatus={{ pending: feedPending === 'url', state: urlFlash.state, detail: urlFlash.detail }}
      />
    </div>
    </>
  );
}
