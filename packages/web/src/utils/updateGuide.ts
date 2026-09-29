/**
 * Settings › Updates: the update steps for each way tagave can be installed.
 * The page shows the guide for the detected install first and keeps the
 * others folded away. `version` is the release to move to; null means the
 * page does not know one yet and a placeholder is shown.
 */
import type { InstallInfo, InstallMethod, ReleaseNote } from '@liner/shared';

export interface UpdateStep {
  /** Plain sentence; may be empty when the command speaks for itself. */
  text: string;
  command?: string;
}

export interface UpdateGuide {
  method: InstallMethod;
  title: string;
  intro: string;
  steps: UpdateStep[];
}

const INSTALLER_URL = 'https://raw.githubusercontent.com/xooxoxxo/tagave/main/install-tagave.sh';
/** Run inside the app container: a verified dump to /cache/backups, the last 14 kept. */
const IN_APP_BACKUP = 'node packages/doctor/dist/cli.js backup --keep 14';
const SOURCE_COMPOSE = 'docker compose -f docker-compose.prod.yml';
const SOURCE_REBUILD = `GIT_SHA=$(git rev-parse --short HEAD) BUILT_AT=$(date -u +%FT%TZ) \\\n  ${SOURCE_COMPOSE} --profile workers up -d --build`;

function backupCommand(compose: string, version: string): string {
  return `${compose} exec -T postgres pg_dump -U liner -Fc liner > tagave-before-${version}.pgdump`;
}

/** `sed -i.bak` works with both GNU and BSD sed. */
function pinCommand(version: string): string {
  return `sed -i.bak 's/^TAGAVE_VERSION=.*/TAGAVE_VERSION=${version}/' .env`;
}

export function updateGuide(method: InstallMethod, install: Pick<InstallInfo, 'role'>, version: string | null): UpdateGuide {
  const v = version ?? '<version>';
  const split = install.role === 'app'
    ? ' This is a split install: run the same command on the computer with the music afterwards, so the file worker matches.'
    : '';
  switch (method) {
    case 'installer':
      return {
        method,
        title: 'Installed with install-tagave.sh',
        intro: `Run this on the computer that runs tagave. It backs up the database, sets the version to ${v}, fetches the new images and restarts.${split}`,
        steps: [
          { text: '', command: `cd ~/tagave\nbash -c "$(curl -fsSL ${INSTALLER_URL})" _ update --version ${v}` },
          {
            text: 'Or by hand, in the same folder:',
            command: [backupCommand('docker compose', v), pinCommand(v), 'docker compose pull', 'docker compose up -d'].join('\n'),
          },
        ],
      };
    case 'compose':
      return {
        method,
        title: 'Docker Compose',
        intro: 'Run these in the folder with your compose file and .env. Take the backup first: database changes only go forward.',
        steps: [
          { text: '', command: [backupCommand('docker compose', v), pinCommand(v), 'docker compose pull', 'docker compose up -d'].join('\n') },
          { text: 'If your compose file names the image tag directly instead of TAGAVE_VERSION, change the tag of the app and both workers to the new version before pulling.' },
        ],
      };
    case 'portainer':
      return {
        method,
        title: 'Portainer',
        intro: 'Back up the database first: database changes only go forward.',
        steps: [
          { text: 'Containers › the tagave app container › Console (Connect), then run:', command: IN_APP_BACKUP },
          { text: `Stacks › tagave › Editor: under Environment variables set TAGAVE_VERSION to ${v}.` },
          { text: 'Turn on "Re-pull image and redeploy", then press Update the stack.' },
        ],
      };
    case 'dokploy':
      return {
        method,
        title: 'Dokploy',
        intro: 'Back up the database first: database changes only go forward.',
        steps: [
          { text: 'Open the tagave service › Docker Terminal, pick the app container and run:', command: IN_APP_BACKUP },
          { text: `Environment: set TAGAVE_VERSION=${v} and save.` },
          { text: 'Press Deploy. Dokploy pulls the new images and restarts the stack.' },
        ],
      };
    case 'coolify':
      return {
        method,
        title: 'Coolify',
        intro: 'Back up the database first: database changes only go forward.',
        steps: [
          { text: 'Open the tagave resource › Terminal, pick the app container and run:', command: IN_APP_BACKUP },
          { text: `Environment Variables: set TAGAVE_VERSION=${v} and save.` },
          { text: 'Press Redeploy. Coolify pulls the new images and restarts the stack.' },
        ],
      };
    case 'unraid':
      return {
        method,
        title: 'Unraid',
        intro: 'Back up the database first, then move every tagave container to the same version.',
        steps: [
          { text: 'Docker tab › tagave › Console, then run:', command: IN_APP_BACKUP },
          { text: `Docker tab › tagave › Edit: change the Repository tag to :${v} and press Apply. Do the same for each tagave worker container.` },
        ],
      };
    case 'source':
      return {
        method,
        title: 'Built from source',
        intro: 'Run these in the folder you installed from, on the computer that runs the app. Database changes only go forward, so take the backup first.',
        steps: [
          { text: 'Back up the database:', command: backupCommand(SOURCE_COMPOSE, v) },
          { text: 'Get the new version and rebuild. This restarts the app and, if they run here, both workers:', command: `git fetch --tags\ngit checkout v${v}\n${SOURCE_REBUILD}` },
          { text: 'Workers on another computer need the same version: check out the same tag there, run pnpm install && pnpm -r build, then restart both worker processes.' },
        ],
      };
    case 'unknown':
    default:
      return updateGuide('installer', install, version);
  }
}

/** The detected install first, then the common ways; platform guides only when detected. */
export function guideOrder(method: InstallMethod): InstallMethod[] {
  const common: InstallMethod[] = ['installer', 'compose', 'source'];
  const first: InstallMethod = method === 'unknown' ? 'installer' : method;
  return [first, ...common.filter((m) => m !== first)];
}

/** Rollback for the source install (the others roll back by setting the old version and restoring). */
export function rollbackCommand(method: InstallMethod, previous: string): string {
  if (method === 'source') {
    return [
      `git checkout v${previous}`,
      `${SOURCE_COMPOSE} --profile workers stop app worker-files worker-identify`,
      `${SOURCE_COMPOSE} exec -T postgres pg_restore -U liner -d liner --clean --if-exists < tagave-before-<version>.pgdump`,
      SOURCE_REBUILD,
    ].join('\n');
  }
  return [
    pinCommand(previous),
    'docker compose stop app worker-files worker-identify',
    'docker compose exec -T postgres pg_restore -U liner -d liner --clean --if-exists < tagave-before-<version>.pgdump',
    'docker compose up -d',
  ].join('\n');
}

/**
 * Releases between the running version and the target that are marked
 * "requires attention": the page wants each read before it shows commands.
 */
export function attentionReleases(newer: ReleaseNote[]): ReleaseNote[] {
  return newer.filter((r) => r.requiresAttention);
}
