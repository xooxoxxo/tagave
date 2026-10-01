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

export interface RollbackGuide {
  intro: string;
  steps: UpdateStep[];
}

const INSTALLER_URL = 'https://raw.githubusercontent.com/xooxoxxo/tagave/main/install-tagave.sh';
/** Where the app container's own backups (doctor backup, nightly, before-update) go: the backups volume. */
const IN_APP_BACKUP_DIR = '/backups';
/** Run inside the app container: a verified dump to /backups, the last 14 manual ones kept. */
const IN_APP_BACKUP = 'node packages/doctor/dist/cli.js backup --keep 14';
/** install-tagave.sh update keeps its copy of the configuration and database here, in the install folder. */
const INSTALLER_BACKUP_DIR = 'backups/pre-update-';
const SOURCE_COMPOSE = 'docker compose -f docker-compose.prod.yml';
const SOURCE_REBUILD = `GIT_SHA=$(git rev-parse --short HEAD) BUILT_AT=$(date -u +%FT%TZ) \\\n  ${SOURCE_COMPOSE} --profile workers up -d --build`;

/**
 * Where each method's backup step puts the dump. The update guide and the
 * roll back both use this, so they cannot drift apart.
 */
export function backupLocation(method: InstallMethod, version: string | null): string {
  switch (method) {
    case 'installer':
    case 'unknown':
      return INSTALLER_BACKUP_DIR;
    case 'portainer':
    case 'dokploy':
    case 'coolify':
    case 'unraid':
      return IN_APP_BACKUP_DIR;
    case 'compose':
    case 'source':
    default:
      return `tagave-before-${version ?? '<version>'}.pgdump`;
  }
}

// $POSTGRES_USER and $POSTGRES_DB expand inside the postgres container, so a
// renamed database user works too.
function dumpCommand(compose: string, file: string): string {
  return `${compose} exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > ${file}`;
}

/** Empties the database and loads the dump; --exit-on-error stops at the first problem. */
function restoreCommands(compose: string, file: string): string[] {
  return [
    `${compose} exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'`,
    `${compose} exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < ${file}`,
  ];
}

/** `sed -i.bak` works with both GNU and BSD sed. */
function pinCommand(version: string): string {
  return `sed -i.bak 's/^TAGAVE_VERSION=.*/TAGAVE_VERSION=${version}/' .env`;
}

/**
 * Commands joined with &&, one per line: pasted as a block, the first one
 * that fails stops the rest, so a failed backup never goes on to the update
 * and a failed restore never starts the older version.
 */
function chain(commands: string[]): string {
  return commands.join(' &&\n');
}

function composeUpdate(v: string): string {
  return chain([dumpCommand('docker compose', backupLocation('compose', v)), pinCommand(v), 'docker compose pull', 'docker compose up -d']);
}

/** Restore first; pin the older version only after the restore worked. */
function composeRollback(previous: string, file: string): string {
  return chain([
    `test -s ${file}`,
    'docker compose stop',
    'docker compose up -d --wait postgres',
    ...restoreCommands('docker compose', file),
    pinCommand(previous),
    'docker compose pull',
    'docker compose up -d',
  ]);
}

export function updateGuide(method: InstallMethod, install: Pick<InstallInfo, 'role'>, version: string | null): UpdateGuide {
  const v = version ?? '<version>';
  const split = install.role === 'app'
    ? ' This is a split install: run the same command on the computer with the music afterwards, so the file worker matches.'
    : '';
  const inApp = `The backup goes to ${IN_APP_BACKUP_DIR} inside the container.`;
  switch (method) {
    case 'installer':
      return {
        method,
        title: 'Installed with install-tagave.sh',
        intro: `Run this on the computer that runs tagave. It backs up the database to ${INSTALLER_BACKUP_DIR}… in the install folder, sets the version to ${v}, fetches the new images and restarts.${split}`,
        steps: [
          { text: '', command: `bash -c "$(curl -fsSL ${INSTALLER_URL})" _ update --version ${v}` },
          { text: 'If you installed somewhere other than ~/tagave, add --dir with that folder.' },
          { text: 'Or by hand, in the install folder:', command: composeUpdate(v) },
        ],
      };
    case 'compose':
      return {
        method,
        title: 'Docker Compose',
        intro: 'Run these in the folder with your compose file and .env. The backup comes first and the rest only runs if it worked: database changes only go forward.',
        steps: [
          { text: '', command: composeUpdate(v) },
          { text: 'If your compose file names the image tag directly instead of TAGAVE_VERSION, change the tag of the app and both workers to the new version before pulling.' },
        ],
      };
    case 'portainer':
      return {
        method,
        title: 'Portainer',
        intro: `Back up the database first: database changes only go forward. ${inApp}`,
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
        intro: `Back up the database first: database changes only go forward. ${inApp}`,
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
        intro: `Back up the database first: database changes only go forward. ${inApp}`,
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
        intro: `Back up the database first, then move every tagave container to the same version. ${inApp}`,
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
          { text: 'Back up the database:', command: dumpCommand(SOURCE_COMPOSE, backupLocation('source', v)) },
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

/** Platform roll back: restore inside the app container, then redeploy the older version. */
function platformRollback(redeploy: string): RollbackGuide {
  return {
    intro: `Put back the backup you took in ${IN_APP_BACKUP_DIR}, then go back to the older version.`,
    steps: [
      {
        text: 'Open the console of the tagave app container, as for the backup, and find the backup you made just before the update:',
        command: `ls -lt ${IN_APP_BACKUP_DIR}`,
      },
      {
        text: 'Put that file name in the first line, then run. Nothing changes if the file is missing or cannot be read:',
        command: [
          `F=${IN_APP_BACKUP_DIR}/liner-<date>.pgdump`,
          chain([
            'test -s "$F"',
            'pg_restore --list "$F" > /dev/null',
            'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"',
            'pg_restore --no-owner --exit-on-error -d "$DATABASE_URL" "$F"',
            'echo "Restored $F"',
          ]),
        ].join('\n'),
      },
      { text: `Only once it says Restored: ${redeploy}` },
    ],
  };
}

/**
 * How to go back to `previous` (the version running before the update),
 * using the backup the same method's update steps took. `target` is the
 * version updated to; it names the compose and source dumps.
 */
export function rollbackGuide(method: InstallMethod, install: Pick<InstallInfo, 'role'>, previous: string, target: string | null): RollbackGuide {
  const split = install.role === 'app'
    ? ' Then, on the computer with the music, set the file worker back to the same version.'
    : '';
  switch (method) {
    case 'installer':
    case 'unknown': {
      const handFile = backupLocation('compose', target);
      return {
        intro: `The update printed these steps at its end, with the exact folder. They use the backup it made in ${INSTALLER_BACKUP_DIR}… in the install folder and stop at the first step that fails.${split}`,
        steps: [
          {
            text: 'In the install folder (~/tagave unless you chose another with --dir):',
            command: chain([
              `B=$(ls -td ${INSTALLER_BACKUP_DIR}*/ | head -n 1)`,
              'echo "Using $B"',
              'test -s "$B/database.pgdump"',
              'docker compose stop',
              'docker compose up -d --wait postgres',
              ...restoreCommands('docker compose', '"$B/database.pgdump"'),
              'cp -p "$B".env "$B"*.yml .',
              'docker compose pull',
              'docker compose up -d',
            ]),
          },
          { text: `If you updated by hand instead, with the backup in ${handFile}:`, command: composeRollback(previous, handFile) },
        ],
      };
    }
    case 'compose':
      return {
        intro: 'In the folder with your compose file and .env. The steps stop at the first one that fails, so the older version never starts on a database that was not restored.',
        steps: [{ text: '', command: composeRollback(previous, backupLocation('compose', target)) }],
      };
    case 'source': {
      const file = backupLocation('source', target);
      return {
        intro: 'In the folder you installed from. The steps stop at the first one that fails, so the older version never starts on a database that was not restored.',
        steps: [{
          text: '',
          command: chain([
            `test -s ${file}`,
            `${SOURCE_COMPOSE} --profile workers stop`,
            `${SOURCE_COMPOSE} up -d --wait postgres`,
            ...restoreCommands(SOURCE_COMPOSE, file),
            `git checkout v${previous}`,
            SOURCE_REBUILD,
          ]),
        }],
      };
    }
    case 'portainer':
      return platformRollback(`Stacks › tagave › Editor: set TAGAVE_VERSION to ${previous}, turn on "Re-pull image and redeploy" and press Update the stack.`);
    case 'dokploy':
      return platformRollback(`Environment: set TAGAVE_VERSION=${previous}, save and press Deploy.`);
    case 'coolify':
      return platformRollback(`Environment Variables: set TAGAVE_VERSION=${previous}, save and press Redeploy.`);
    case 'unraid':
      return platformRollback(`Docker tab › tagave › Edit: change the Repository tag to :${previous} and press Apply, then the same for each tagave worker container.`);
    default:
      return rollbackGuide('installer', install, previous, target);
  }
}

/**
 * Releases between the running version and the target that are marked
 * "requires attention": the page wants each read before it shows commands.
 */
export function attentionReleases(newer: ReleaseNote[]): ReleaseNote[] {
  return newer.filter((r) => r.requiresAttention);
}
