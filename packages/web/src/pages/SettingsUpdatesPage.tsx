/**
 * Settings › Updates (spec PLT-5, XO-313): what is running where (app vs
 * workers, with a mismatch warning for a lagging host), the release feed
 * with in-app changelogs, and the per-host update procedure. The feed is
 * checked once a day when the page is opened, or on demand.
 */
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import ReactMarkdown from 'react-markdown';
import type { ReleaseNote, WorkerVersion } from '@liner/shared';
import { useCurrentLibrary } from '../hooks';
import { useCheckUpdates, useSetUpdatesFeed, useUpdates } from '../hooks/useUpdates';
import { Button } from '../components/ui';
import styles from './SettingsUpdatesPage.module.css';

const DAY_MS = 24 * 3600 * 1000;

// Update commands for the shipped docker-compose.prod.yml. It builds from the
// checkout (no published image to pull), so an update is pull + rebuild; the
// build args are what the "same build" check above compares.
const COMPOSE = 'docker compose -f docker-compose.prod.yml';
const REBUILD = `GIT_SHA=$(git rev-parse --short HEAD) BUILT_AT=$(date -u +%FT%TZ) \\
  ${COMPOSE} --profile workers up -d --build`;
const BACKUP_CMD = `${COMPOSE} exec -T postgres pg_dump -U liner -Fc liner > tagave-$(date +%F).pgdump`;
const UPDATE_CMD = `git pull\n${REBUILD}`;
// The one-command installer pins the release in ~/tagave/.env and keeps a
// copy of itself there; its update command backs up, moves the pin, pulls and
// restarts, so a plain `docker compose pull` no longer changes the version.
const INSTALLER_UPDATE_CMD = 'cd ~/tagave\n./install-tagave.sh update';
const ROLLBACK_CMD = [
  'git checkout <previous version>',
  `${COMPOSE} --profile workers stop app worker-files worker-identify`,
  `${COMPOSE} exec -T postgres pg_restore -U liner -d liner --clean --if-exists < tagave-<date>.pgdump`,
  REBUILD,
].join('\n');

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
          A worker runs a different build than the app. Bring the lagging side to the same version and restart it, as described under How to update below.
        </div>
      )}

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
        <h2 className={styles.sectionTitle}>Release feed</h2>
        <p className={styles.hint}>
          A GitHub Releases API URL, e.g. <code>https://api.github.com/repos/OWNER/REPO/releases</code>. Checked daily when this page is open and on demand;
          responses are cached by ETag. Leave it empty to turn update checks off.
        </p>
        <div className={styles.row}>
          <input
            className={styles.input}
            placeholder="https://api.github.com/repos/…/releases"
            value={feedUrl}
            onChange={(e) => setFeedUrl(e.target.value)}
          />
          <Button disabled={setFeed.isPending || feedUrl.trim() === (feed.url ?? '')} onClick={() => setFeed.mutate(feedUrl.trim() || null)}>
            Save
          </Button>
          <Button variant="secondary" disabled={!feed.enabled || check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? 'Checking…' : 'Check now'}
          </Button>
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
        <h3 className={styles.subTitle}>If you used the installer</h3>
        <p className={styles.hint}>
          Run this in the folder the installer wrote to (<code>~/tagave</code> unless you chose another). It backs up the database, moves to the newest release, restarts the app and then the workers, and prints how to roll back.
          On a split install, run it on the app computer first, then on the computer with the music.
          If <code>install-tagave.sh</code> is not in that folder yet, run the one-command installer once more first; it keeps your settings and adds it.
        </p>
        <pre className={styles.code}>{INSTALLER_UPDATE_CMD}</pre>
        <h3 className={styles.subTitle}>If you built from source</h3>
        <p className={styles.hint}>
          Run these in the folder you installed from, on the machine that runs the app. Database changes are applied when the app starts and only go forward: an older version cannot use a database a newer one has changed, so take the backup first.
        </p>
        <ol className={styles.steps}>
          <li>
            <strong>Back up the database.</strong>
            <pre className={styles.code}>{BACKUP_CMD}</pre>
          </li>
          <li>
            <strong>Get the new version and rebuild.</strong> This restarts the app and, if they run on this machine, both workers.
            <pre className={styles.code}>{UPDATE_CMD}</pre>
          </li>
          <li>
            <strong>Workers on another machine</strong> need the same version: update that copy to the same commit, run <code>pnpm install &amp;&amp; pnpm -r build</code>, then restart both worker processes.
          </li>
          <li>
            <strong>Check.</strong> The table above lists every process at the same build, and <Link to="/settings/system">System status</Link> shows no failures.
          </li>
          <li>
            <strong>If something goes wrong</strong>, go back to the version you had and restore the backup from step 1:
            <pre className={styles.code}>{ROLLBACK_CMD}</pre>
          </li>
        </ol>
      </section>
    </div>
  );
}
