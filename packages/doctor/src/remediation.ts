import type { Check } from './checks.js';

/**
 * What to do about a check that did not pass, in plain words. Returns null
 * for a passing or skipped check. The text depends on the check id and its
 * status only (never on secrets), so it is safe to show next to the check on
 * the status page and in the first-run wizard, and to print from the CLI.
 *
 * Every process (app and workers) reads the same database, so a check that
 * reads the database answers for the whole install; the cache-directory and
 * app-secret checks answer for the host that ran them.
 */
export function remediationFor(check: Pick<Check, 'id' | 'status' | 'detail'>): string | null {
  if (check.status === 'pass' || check.status === 'skip') return null;
  const failed = check.status === 'fail';

  switch (check.id) {
    case 'database':
      return 'The app cannot reach Postgres. Check that the database container or service is running, and that DATABASE_URL in the app environment has the right host, port, user and password. If the database runs on another machine, check that the app host can reach it on the network.';
    case 'migrations':
      return failed
        ? 'The database schema is behind this build. Migrations run when the app starts: restart the app and read its log for the migration that failed. The worker hosts must run the same build.'
        : 'The database has migrations this build does not know, usually because the workers run a newer build than the app. Deploy the same version to the app and every worker.';
    case 'contactString':
      return 'MusicBrainz and Discogs refuse anonymous clients, so no lookups run until a contact is set. Add an email address or a website under Settings › Integrations.';
    case 'workerHeartbeat':
      return failed
        ? 'No worker has checked in during the last two minutes, so nothing will be scanned or identified. Start the worker: with the bundled Compose file, `docker compose -f docker-compose.prod.yml --profile workers up -d` (the workers only start with that profile); outside Docker, `node packages/worker/dist/index.js` with DATABASE_URL set. On a separate worker host, check that its DATABASE_URL points at this same database and that the host can reach it on the network.'
        : 'Fewer workers are running than this install expects. Scans and identification still run, only slower. Start the missing worker, or ignore this if you run one worker on purpose.';
    case 'versions':
      return 'The app and the workers run different builds. Deploy the same version everywhere; the app and each worker host update separately.';
    case 'scanRoots':
      return failed
        ? 'A music folder cannot be read by the worker. The path is checked on the worker host, not on the web server: mount the drive or share there (in Docker, bind-mount it into the worker container at the same path), give the worker user read access, then press Re-check under Settings › Music folders.'
        : 'Add a music folder under Settings › Music folders, or open that page and press Re-check on a folder whose check is old or still waiting.';
    case 'cacheDir':
      return 'The cache folder on this host is missing or not writable. Create it and give the app user write access, or point CACHE_DIR at a writable folder and restart.';
    case 'providers':
      return failed
        ? 'A metadata service could not be reached from this host. Check that the host has internet access and that no firewall or proxy blocks musicbrainz.org and api.discogs.com.'
        : 'A metadata service answered with a warning. A busy MusicBrainz clears by itself within minutes; a Discogs token that is not accepted should be replaced under Settings › Integrations.';
    case 'appSecret':
      return failed
        ? 'APP_SECRET is too short. Generate one with `openssl rand -hex 32`, set it in the app environment and restart.'
        : 'APP_SECRET is weaker than recommended, or a worker host that needs it does not have it. Set the same APP_SECRET on every host; to rotate it, see `liner-doctor reseal`.';
    default:
      return null;
  }
}
