/**
 * Settings › Updates (spec PLT-5, XO-313): whether a newer release exists
 * and what it changes, the update steps for the way this server was
 * installed (that one first, the others folded away), what is running where
 * (app vs workers, with a warning for a lagging host), and the update-check
 * switch. The server checks the official release feed on its own at most
 * every 12 hours. With the opt-in updater installed, the page also starts
 * an update and follows it (InAppUpdate); without it, it shows the command.
 */
import { useEffect, useState } from 'react';
import { docsUrl } from '../utils/docs';
import ReactMarkdown from 'react-markdown';
import type { InstallMethod, ReleaseNote, UpdatesStatus, WorkerVersion } from '@tagave/shared';
import { useCurrentLibrary } from '../hooks';
import { useCheckUpdates, useSetUpdatesFeed, useSkipUpdate, useUpdates } from '../hooks/useUpdates';
import { useUpdater } from '../hooks/useUpdater';
import { InAppUpdate, RunView, useShownRun } from '../components/InAppUpdate';
import { Banner, Button } from '../components/ui';
import { attentionReleases, guideOrder, rollbackGuide, updateGuide, type RollbackGuide } from '../utils/updateGuide';
import { shortDate } from '../utils/time';
import styles from './SettingsUpdatesPage.module.css';

/** "11 Oct, 19:29", the app's date format; the year only when it is not this one. */
function when(iso: string | null | undefined): string {
  return iso ? shortDate(iso) : '–';
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
  return sha ? sha.slice(0, 7) : 'unknown';
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
  if (queues.length === 0) return '–';
  const kinds = new Set(queues.map((q) => WORK.find(([, re]) => re.test(q))?.[0] ?? 'upkeep'));
  return [...WORK.map(([k]) => k), 'upkeep'].filter((k) => kinds.has(k)).join(', ');
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

export function SettingsUpdatesPage() {
  const { libraryId } = useCurrentLibrary();
  const { data, isLoading } = useUpdates(libraryId);
  if (isLoading) return <><h2>Updates</h2><p className={styles.muted}>Loading…</p></>;
  // A failed refetch keeps the last answer: during an in-app update the app
  // restarts and this page must stay put.
  if (!data) return <><h2>Updates</h2><Banner tone="danger">Could not load update status.</Banner></>;
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
  const [feedUrl, setFeedUrl] = useState(feed.custom ? feed.url ?? '' : '');
  useEffect(() => { setFeedUrl(feed.custom ? feed.url ?? '' : ''); }, [feed.custom, feed.url]);

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

  // While a run is on screen it is the whole page (the section list stays beside it).
  if (inApp && shown.run) {
    return <RunView run={shown.run} disconnected={disconnected} reloading={shown.reloading} restart={shown.restart} onDismiss={shown.dismiss} />;
  }

  const manual = confirmed ? (
      <div className={styles.guide}>
        <h3 className={styles.subTitle}>
          {primary!.title}
          {detected !== 'unknown' && <span className={styles.detected}>this server</span>}
        </h3>
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
    <h2>Updates</h2>
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
      {data.mismatch && (
        <Banner tone="warning">A worker runs a different build than the app.</Banner>
      )}

      {feed.newer.length > 0 && (
        <section className={styles.section} aria-labelledby="updates-new">
          <h3 id="updates-new" className={styles.title}>What’s new</h3>
          {feed.newer.map((r) => <ReleaseArticle key={r.tag} release={r} open={r.requiresAttention || r === target} />)}
        </section>
      )}

      <section className={styles.section} aria-labelledby="updates-update">
        <h3 id="updates-update" className={styles.title}>{inApp ? 'Update this server' : target ? `Update to ${target.version}` : 'How to update'}</h3>
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
            {!target && upToDate && <p className={styles.hint}>Up to date · {app.version}</p>}
            {manual}
            {uv && !uv.installed && (
              <a className={styles.hint} href={docsUrl('install.md#updating-from-the-app-optional-updater')} target="_blank" rel="noreferrer">Update from this page</a>
            )}
          </>
        )}
      </section>

      <section className={styles.section} aria-labelledby="updates-running">
        <h3 id="updates-running" className={styles.title}>Running now</h3>
        {/* seven columns never fit a phone; the table scrolls inside its own box
            instead of pushing the whole page sideways */}
        <div className={styles.tableScroll}>
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
              <td className={styles.dim}>–</td>
            </tr>
            {workers.length === 0 && (
              <tr><td colSpan={7} className={styles.dim}>No workers seen</td></tr>
            )}
            {workers.map((w) => {
              const lagging = !!(w.sha && app.sha && w.sha !== app.sha);
              return (
                <tr key={w.workerId} className={lagging ? styles.rowWarn : undefined}>
                  <td><strong>Worker</strong> <span className={styles.dim}>{workerName(w)}</span></td>
                  <td>{w.version ?? '–'}</td>
                  <td title={w.sha ?? undefined}><code>{shortSha(w.sha)}</code>{lagging && <span className={styles.attention}>lagging</span>}</td>
                  <td title={fullDate(w.builtAt)}>{when(w.builtAt)}</td>
                  <td className={styles.queues} title={w.queues.join(', ')}>{workOf(w.queues)}</td>
                  <td title={fullDate(w.lastSeenAt)}>{ago(w.lastSeenAt)}</td>
                  <td className={w.loopLagMs != null && w.loopLagMs > 5000 ? styles.attentionText : undefined}>
                    {w.loopLagMs != null ? `${w.loopLagMs} ms` : '–'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="updates-checks">
        <h3 id="updates-checks" className={styles.title}>Update checks</h3>
        {feed.lockedByServer ? (
          <p className={styles.hint}>
            {feed.enabled ? <><code>TAGAVE_UPDATE_FEED</code>: <code>{feed.url}</code></> : <>Off (<code>TAGAVE_UPDATE_FEED=off</code>)</>}
          </p>
        ) : (
          <label className={styles.gateCheck}>
            <input type="checkbox" checked={feed.enabled} disabled={setFeed.isPending} onChange={(e) => setFeed.mutate({ enabled: e.target.checked })} />
            Auto-check
          </label>
        )}
        <div className={styles.row}>
          <Button variant="secondary" size="sm" disabled={!feed.enabled || check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? 'Checking…' : 'Check now'}
          </Button>
          <span className={styles.muted}>
            {!feed.enabled ? 'Off'
              : feed.lastCheckedAt ? <span title={fullDate(feed.lastCheckedAt)}>{when(feed.lastCheckedAt)}</span> : 'Not checked yet'}
            {feed.enabled && feed.error ? ` · Failed: ${feed.error}` : ''}
          </span>
        </div>
        {!feed.lockedByServer && feed.enabled && (
          <details className={styles.more} open={feed.custom}>
            <summary>Release feed</summary>
            <div className={styles.row}>
              <input
                className={styles.input}
                aria-label="Release feed URL"
                placeholder={feed.defaultUrl}
                value={feedUrl}
                onChange={(e) => setFeedUrl(e.target.value)}
              />
              <Button size="sm" disabled={setFeed.isPending || feedUrl.trim() === (feed.custom ? feed.url ?? '' : '')} onClick={() => setFeed.mutate({ url: feedUrl.trim() || null })}>
                Save
              </Button>
            </div>
            {setFeed.isError && <p className={styles.error}>Use a GitHub releases API URL</p>}
          </details>
        )}
      </section>
    </div>
    </>
  );
}
