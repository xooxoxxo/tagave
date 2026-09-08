/**
 * Settings › Updates (spec PLT-5, XO-313): what is running where (app vs
 * workers, with a mismatch warning for a lagging host), the release feed
 * with in-app changelogs, and the per-host update procedure. The feed is
 * checked once a day when the page is opened, or on demand.
 */
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ReleaseNote, WorkerVersion } from '@liner/shared';
import { useCurrentLibrary } from '../hooks';
import { useCheckUpdates, useSetUpdatesFeed, useUpdates } from '../hooks/useUpdates';
import styles from './SettingsUpdatesPage.module.css';

const DAY_MS = 24 * 3600 * 1000;

function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '–';
}
function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : 'unknown';
}
function workerName(w: WorkerVersion): string {
  return w.host ?? w.workerId.replace(/^worker-/, '');
}

export function SettingsUpdatesPage() {
  const { libraryId } = useCurrentLibrary();
  const { data, isLoading, error } = useUpdates(libraryId);
  const setFeed = useSetUpdatesFeed(libraryId);
  const check = useCheckUpdates(libraryId);
  const [feedUrl, setFeedUrl] = useState('');
  useEffect(() => { setFeedUrl(data?.feed.url ?? ''); }, [data?.feed.url]);

  // Daily check on open (spec: "daily + manual").
  useEffect(() => {
    if (!data?.feed.enabled || check.isPending) return;
    const last = data.feed.lastCheckedAt ? Date.parse(data.feed.lastCheckedAt) : 0;
    if (Date.now() - last > DAY_MS) check.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.feed.enabled, data?.feed.lastCheckedAt]);

  if (isLoading) return <div className={styles.container}>Loading…</div>;
  if (error || !data) return <div className={styles.container}><div className={styles.error}>Could not load update status.</div></div>;

  const { app, workers, feed } = data;
  const current = `${app.version}${app.sha ? ` @ ${shortSha(app.sha)}` : ''}`;

  return (
    <div className={styles.container}>
      {/* rendered inside the Settings shell (SettingsPage → PageShell tabs); no page header here */}
      {data.updateAvailable && feed.newer[0] && (
        <div className={styles.banner}>
          <strong>Update available:</strong> {feed.newer[0].tag}{feed.newer[0].name ? ` — ${feed.newer[0].name}` : ''}
          {feed.newer[0].requiresAttention && <span className={styles.attention}>requires attention</span>}
        </div>
      )}
      {data.mismatch && (
        <div className={styles.warn}>
          A worker runs a different build than the app. Workers on the g9 host deploy separately (<code>scripts/deploy.sh workers</code>) — redeploy the lagging side.
        </div>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Running now</h2>
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
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Release feed</h2>
        <p className={styles.hint}>
          A GitHub Releases API URL, e.g. <code>https://api.github.com/repos/OWNER/REPO/releases</code>. Checked daily when this page is open and on demand;
          responses are cached by ETag. Until the repository is published there is nothing to point at — leave it empty.
        </p>
        <div className={styles.row}>
          <input
            className={styles.input}
            placeholder="https://api.github.com/repos/…/releases"
            value={feedUrl}
            onChange={(e) => setFeedUrl(e.target.value)}
          />
          <button className={styles.button} disabled={setFeed.isPending || feedUrl.trim() === (feed.url ?? '')} onClick={() => setFeed.mutate(feedUrl.trim() || null)}>
            Save
          </button>
          <button className={styles.button} disabled={!feed.enabled || check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? 'Checking…' : 'Check now'}
          </button>
        </div>
        <p className={styles.muted}>
          {feed.enabled ? `Last checked ${when(feed.lastCheckedAt)}` : 'Feed disabled'}
          {feed.error ? ` · last error: ${feed.error}` : ''}
          {feed.enabled && !feed.error && feed.lastCheckedAt && !data.updateAvailable ? ` · ${current} is the latest known release` : ''}
        </p>
        {feed.newer.map((r: ReleaseNote) => (
          <article key={r.tag} className={styles.release}>
            <header className={styles.releaseHead}>
              <strong>{r.tag}</strong>
              {r.name && <span>{r.name}</span>}
              {r.publishedAt && <span className={styles.muted}>{when(r.publishedAt)}</span>}
              {r.requiresAttention && <span className={styles.attention}>requires attention</span>}
              {r.url && <a href={r.url} target="_blank" rel="noreferrer">release page ↗</a>}
            </header>
            <div className={styles.markdown}>
              {r.body ? <ReactMarkdown>{r.body}</ReactMarkdown> : <p className={styles.muted}>No release notes.</p>}
            </div>
          </article>
        ))}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>How to update</h2>
        <p className={styles.hint}>
          One-click updates arrive with the containerised workers (XO-296): the app pulls the new image tag and restarts itself. Until then, updates are two commands from the dev checkout — migrations run on boot, forward-only.
        </p>
        <ol className={styles.steps}>
          <li>
            <strong>Snapshot first.</strong>
            <pre className={styles.code}>docker exec liner-postgres-1 pg_dump -U liner -Fc liner &gt; liner-$(date +%F).pgdump</pre>
          </li>
          <li>
            <strong>App container</strong> (web + API, on the VM):
            <pre className={styles.code}>cd ~/Workspace/liner &amp;&amp; DEPLOY_FROM_HEAD=1 scripts/deploy.sh app</pre>
          </li>
          <li>
            <strong>Workers</strong> (g9 host; restarts both processes, in-flight identify jobs retry):
            <pre className={styles.code}>DEPLOY_FROM_HEAD=1 scripts/deploy.sh workers</pre>
          </li>
          <li>
            <strong>Verify</strong>: this page shows every process at the same build; <code>liner-doctor doctor</code> reports <em>Build Versions</em>.
          </li>
          <li>
            <strong>Roll back</strong>: <code>git checkout &lt;previous sha&gt;</code> and run the same two deploys — migrations already applied stay applied (they are forward-only by design), so only roll back to a build that knows them.
          </li>
        </ol>
      </section>
    </div>
  );
}
