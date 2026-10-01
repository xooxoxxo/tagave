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
      if (failed && /^Database is newer than this build/.test(check.detail)) {
        return 'A newer version of tagave has already updated this database, and an older app must not run on it. Update this app to that version or newer. To go back to the older version instead, restore the backup the newer version took before it updated the database (see "Roll back an update" in the operations guide).';
      }
      return failed
        ? 'The database schema is behind this build. The app applies migrations when it starts, after it has taken a backup: restart the app and read its log. If the log says "Not migrating: the backup before migrating failed", fix the backup folder or pg_dump as it says (or set LINER_SKIP_PREMIGRATE_BACKUP=1 to migrate without a backup) and restart. If another start is migrating, the app waits for it and then starts. Workers wait until the app has migrated, so update the app first.'
        : 'The database has migrations this build does not know: a newer build migrated it, or a migration was renamed before a release. Deploy the same version to the app and every worker. Workers older than the database stop instead of running on it.';
    case 'backups':
      return 'Before it applies a database update, the app backs up the database and refuses to update if that backup fails, so fix this before the next update. Make the backup folder writable (in Docker it is the /backups volume; set LINER_BACKUP_DIR to move it) and make sure pg_dump matches the Postgres server version (the app image ships pg_dump 16). If the last update ran without a backup, take one now with `liner-doctor backup`. This check only matters on the computer that runs the app.';
    case 'contactString':
      return 'MusicBrainz and Discogs refuse anonymous clients, so no lookups run until a contact is set. Add an email address or a website under Settings › Integrations.';
    case 'workerHeartbeat':
      return failed
        ? 'No worker has checked in during the last two minutes, so nothing will be scanned or identified. Start the workers. If you used the installer, run `docker compose up -d` in the folder it installed to (~/tagave unless you chose another), and `docker compose logs worker-files` there says why a worker stopped; on a split install, do the same on the computer with the music. From a source checkout, run `docker compose -f docker-compose.prod.yml --profile workers up -d` (the workers only start with that profile), or outside Docker `node packages/worker/dist/index.js` with DATABASE_URL set. A worker on another computer must point at this same database and be able to reach it over the network. A worker also waits while the app has not finished updating the database, and stops if the database was updated by a newer version than the worker: its log says which, and updating the worker to the app\'s version fixes it.'
        : 'Workers are running, but none of them takes the kind of work named in the check, so that work waits. On a split install, start the missing worker (with the installer, worker-files reads music folders and worker-identify identifies albums), or remove LINER_QUEUES from a worker so it takes every kind of work.';
    case 'versions':
      return 'The app and the workers run different builds. Deploy the same version everywhere; the app and each worker host update separately. Update the app first: a newer worker waits until the app has updated the database, and a worker older than the database stops.';
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
