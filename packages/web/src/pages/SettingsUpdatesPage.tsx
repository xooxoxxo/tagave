/**
 * Settings › Updates (spec PLT-5, XO-313): whether a newer release exists
 * and what it changes, the update steps for the way this server was
 * installed (that one first, the others folded away), what is running where
 * (app vs workers, with a warning for a lagging host), and the update-check
 * switch. The server checks the official release feed on its own at most
 * every 12 hours; nothing here performs an update.
 */
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import ReactMarkdown from 'react-markdown';
import type { InstallMethod, ReleaseNote, UpdatesStatus, WorkerVersion } from '@liner/shared';
import { useCurrentLibrary } from '../hooks';
import { useCheckUpdates, useSetUpdatesFeed, useSkipUpdate, useUpdates } from '../hooks/useUpdates';
import { Button } from '../components/ui';
import { attentionReleases, guideOrder, rollbackGuide, updateGuide, type RollbackGuide } from '../utils/updateGuide';
import styles from './SettingsUpdatesPage.module.css';

function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '–';
}
function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : 'unknown';
}
function workerName(w: WorkerVersion): string {
  return w.host ?? w.workerId.replace(/^worker-/, '');
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
        {release.name && release.name !== release.tag && <span>{release.name}</span>}
        {release.publishedAt && <span className={styles.muted}>{new Date(release.publishedAt).toLocaleDateString()}</span>}
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
  const { data, isLoading, error } = useUpdates(libraryId);
  if (isLoading) return <div className={styles.container}>Loading…</div>;
  if (error || !data) return <div className={styles.container}><div className={styles.error}>Could not load update status.</div></div>;
  return <UpdatesContent data={data} libraryId={libraryId} />;
}

function UpdatesContent({ data, libraryId }: { data: UpdatesStatus; libraryId: string | undefined }) {
  const setFeed = useSetUpdatesFeed(libraryId);
  const check = useCheckUpdates(libraryId);
  const skip = useSkipUpdate(libraryId);
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

  return (
    <div className={styles.container}>
      {/* rendered inside the Settings shell (SettingsPage → PageShell tabs); no page header here */}
      {target && data.updateAvailable && (
        <div className={styles.banner}>
          <span><strong>tagave {target.version} is out.</strong> You run {app.version}.</span>
          {target.requiresAttention && <span className={styles.attention}>requires attention</span>}
          <Button size="sm" variant="quiet" className={styles.bannerAction} disabled={skip.isPending} onClick={() => skip.mutate(target.version)}>
            Skip this version
          </Button>
        </div>
      )}
      {skipped && (
        <p className={styles.muted}>
          You skipped {feed.skippedVersion}. You will hear about the next release.{' '}
          <Button size="sm" variant="quiet" disabled={skip.isPending} onClick={() => skip.mutate(null)}>Show it again</Button>
        </p>
      )}
      {data.mismatch && (
        <div className={styles.warn}>
          A worker runs a different build than the app. Bring the lagging side to the same version and restart it, as described under How to update.
        </div>
      )}

      {feed.newer.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>What’s new</h2>
          {feed.newer.map((r) => <ReleaseArticle key={r.tag} release={r} open={r.requiresAttention || r === target} />)}
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{target ? `Update to ${target.version}` : 'How to update'}</h2>
        {attention.length > 0 && target && (
          <div className={styles.warn}>
            <div>
              <p className={styles.gateText}>
                {attention.length === 1 ? `${attention[0]!.tag} is` : `${attention.map((r) => r.tag).join(', ')} are`} marked
                {' '}<strong>requires attention</strong>: the update may need a step from you. Read the notes above before you update.
              </p>
              <label className={styles.gateCheck}>
                <input type="checkbox" checked={confirmed} onChange={(e) => setReadFor(e.target.checked ? target.version : null)} />
                I have read the notes marked requires attention
              </label>
            </div>
          </div>
        )}
        {confirmed ? (
          <>
            <h3 className={styles.subTitle}>
              {primary!.title}
              {detected !== 'unknown' && <span className={styles.detected}>this server</span>}
            </h3>
            <GuideSteps guide={primary!} />
            <p className={styles.hint}>
              Then check: the table below lists every process at {target ? target.version : 'the new version'}, and <Link to="/settings/system">System status</Link> shows no failures.
            </p>
            <details className={styles.more}>
              <summary>If something goes wrong</summary>
              <p className={styles.hint}>
                Database changes only go forward: an older version cannot use a database a newer one has changed. Go back to the version you had and restore the backup you took.
              </p>
              <GuideSteps guide={rollbackGuide(primary!.method, install, app.version, target?.version ?? null)} />
            </details>
            {others.map((g) => (
              <details key={g.method} className={styles.more}>
                <summary>{g.title}</summary>
                <GuideSteps guide={g} />
              </details>
            ))}
          </>
        ) : (
          <p className={styles.muted}>The update steps appear once you have read the notes.</p>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Running now</h2>
        {/* seven columns never fit a phone; the table scrolls inside its own box
            instead of pushing the whole page sideways */}
        <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr><th>Process</th><th>Version</th><th>Build</th><th>Built</th><th>Queues</th><th>Last seen</th><th>Loop lag</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>App</strong> <span className={styles.muted}>({app.source})</span></td>
              <td>{app.version}</td>
              <td><code>{shortSha(app.sha)}</code></td>
              <td>{when(app.builtAt)}</td>
              <td className={styles.muted}>api + web</td>
              <td className={styles.muted}>now</td>
              <td className={styles.muted}>–</td>
            </tr>
            {workers.length === 0 && (
              <tr><td colSpan={7} className={styles.muted}>No worker heartbeat in the last two minutes.</td></tr>
            )}
            {workers.map((w) => {
              const lagging = !!(w.sha && app.sha && w.sha !== app.sha);
              return (
                <tr key={w.workerId} className={lagging ? styles.rowWarn : undefined}>
                  <td><strong>Worker</strong> <span className={styles.muted}>{workerName(w)}</span></td>
                  <td>{w.version ?? '–'}</td>
                  <td><code>{shortSha(w.sha)}</code>{lagging && <span className={styles.attention}>lagging</span>}</td>
                  <td>{when(w.builtAt)}</td>
                  <td className={styles.queues} title={w.queues.join(', ')}>{w.queues.join(', ')}</td>
                  <td>{when(w.lastSeenAt)}</td>
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

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Update checks</h2>
        <p className={styles.hint}>
          Every 12 hours the server asks GitHub for the list of tagave releases. That request carries nothing about you, this server or your library, and there is no other telemetry.
        </p>
        {feed.lockedByServer ? (
          <p className={styles.hint}>
            {feed.enabled ? <>Set on the server with <code>TAGAVE_UPDATE_FEED</code>: checks read <code>{feed.url}</code>.</> : <>Turned off on the server with <code>TAGAVE_UPDATE_FEED=off</code>.</>}
          </p>
        ) : (
          <label className={styles.gateCheck}>
            <input type="checkbox" checked={feed.enabled} disabled={setFeed.isPending} onChange={(e) => setFeed.mutate({ enabled: e.target.checked })} />
            Check for new versions
          </label>
        )}
        <div className={styles.row}>
          <Button variant="secondary" size="sm" disabled={!feed.enabled || check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? 'Checking…' : 'Check now'}
          </Button>
          <span className={styles.muted}>
            {!feed.enabled ? 'Update checks are off.'
              : feed.lastCheckedAt ? `Last checked ${when(feed.lastCheckedAt)}.` : 'Not checked yet; the first check runs a minute after the server starts.'}
            {feed.enabled && feed.error ? ` The last check failed: ${feed.error}.` : ''}
            {feed.enabled && !feed.error && feed.lastCheckedAt && feed.newer.length === 0 ? ` ${app.version} is the latest release.` : ''}
          </span>
        </div>
        {!feed.lockedByServer && feed.enabled && (
          <details className={styles.more} open={feed.custom}>
            <summary>Use a different release feed</summary>
            <p className={styles.hint}>
              For a fork: a GitHub Releases API URL, such as <code>https://api.github.com/repos/OWNER/REPO/releases</code>. Empty means the official feed, <code>{feed.defaultUrl}</code>.
            </p>
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
            {setFeed.isError && <p className={styles.error}>Could not save: the feed must be a GitHub releases API URL, such as https://api.github.com/repos/OWNER/REPO/releases.</p>}
          </details>
        )}
      </section>
    </div>
  );
}
