/**
 * First-run wizard logic, kept free of React so it can be tested: account
 * validation (the same rules the server applies), which system checks gate
 * setup, and what to tell the owner about a music folder the worker checked.
 */
import { SCAN_ROOT_EMPTY_MESSAGE, setupRequestSchema, type SetupRequest, type ScanRoot } from '@tagave/shared';

/** The whole journey, across /setup and /onboarding. */
export const SETUP_STEPS = ['System check', 'Owner account', 'Music folder', 'First album', 'Protect your account'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export function stepNumber(step: SetupStep): number {
  return SETUP_STEPS.indexOf(step) + 1;
}

export type AccountForm = SetupRequest;
export type AccountErrors = Partial<Record<keyof AccountForm, string>>;

const MESSAGES: Record<keyof AccountForm, string> = {
  email: 'Enter a valid email address.',
  password: 'Use at least 12 characters.',
  displayName: 'Enter the name to show in the app.',
  contactString: 'Enter an email address, or a web address such as https://example.com.',
};

/** What is sent: surrounding spaces dropped from everything but the password. */
export function normalizeAccount(form: AccountForm): AccountForm {
  return { email: form.email.trim(), password: form.password, displayName: form.displayName.trim(), contactString: form.contactString.trim() };
}

/**
 * Field errors for the owner account, from the shared request schema so the
 * wizard can never accept what POST /auth/setup rejects.
 */
export function validateAccount(form: AccountForm): AccountErrors {
  const result = setupRequestSchema.safeParse(normalizeAccount(form));
  if (result.success) return {};
  const errors: AccountErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as keyof AccountForm | undefined;
    if (field && field in MESSAGES && !errors[field]) errors[field] = MESSAGES[field];
  }
  return errors;
}

/** The contact rule on its own, for the settings that edit it after setup. */
export function validateContact(contactString: string): string | undefined {
  return setupRequestSchema.shape.contactString.safeParse(contactString.trim()).success ? undefined : MESSAGES.contactString;
}

export interface SystemCheck {
  id: string;
  title: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detail?: string;
  remediation?: string | null;
}

/**
 * Checks that make sense before an account and a library exist. The contact
 * and music-folder checks always fail on a fresh install; they are later
 * steps of the wizard, not problems.
 */
const INFRASTRUCTURE = ['database', 'migrations', 'workerHeartbeat', 'versions', 'cacheDir', 'backups', 'appSecret'];

export function infrastructureChecks(checks: SystemCheck[]): SystemCheck[] {
  return checks.filter((c) => INFRASTRUCTURE.includes(c.id) && c.status !== 'skip');
}

/** Without the database and its schema, creating the account cannot work. */
export function setupBlocked(checks: SystemCheck[]): boolean {
  return checks.some((c) => (c.id === 'database' || c.id === 'migrations') && c.status === 'fail');
}

/**
 * Whether a live worker takes folder checks. roots.validate runs on the
 * worker that serves scan.root; '*' means a worker without TAGAVE_QUEUES.
 * Undefined while the list of workers is not known.
 */
export function folderCheckerLive(workers: Array<{ queues: string[] }> | undefined): boolean | undefined {
  if (!workers) return undefined;
  return workers.some((w) => w.queues.includes('*') || w.queues.includes('scan.root'));
}

/**
 * What the first-album card says once a scan has started. A finished scan
 * leaves parse and cluster.dir jobs queued (cluster.dir waits 30 s), so no
 * albums yet means "empty" only when nothing is left to group.
 */
export type FirstScanState = 'scanning' | 'grouping' | 'empty' | 'found';

export function firstScanState(input: {
  scanStatus: string | undefined;
  albumsFound: number;
  /** undefined while the stats are loading */
  grouping: number | undefined;
  statsLoaded: boolean;
}): FirstScanState {
  if (input.albumsFound > 0) return 'found';
  if (input.scanStatus !== 'done' || !input.statsLoaded) return 'scanning';
  return (input.grouping ?? 0) > 0 ? 'grouping' : 'empty';
}

export function workerLive(checks: SystemCheck[] | undefined): boolean | undefined {
  const heartbeat = checks?.find((c) => c.id === 'workerHeartbeat');
  if (!heartbeat) return undefined;
  return heartbeat.status === 'pass' || heartbeat.status === 'warn';
}

export interface FolderAdvice {
  tone: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  text: string;
}

/** A folder still waiting after this long, with no worker alive, is stuck. */
export const PENDING_GRACE_MS = 20_000;

/**
 * What the worker found at a music folder, and how to fix it. The path is
 * checked on the worker host (which may not be the machine that serves this
 * page), so every fix is about that host.
 */
export function folderAdvice(
  root: Pick<ScanRoot, 'path' | 'validationStatus' | 'validationMessage' | 'probeWritable' | 'writable' | 'createdAt'>,
  opts: { workerLive?: boolean | undefined; checkerLive?: boolean | undefined; now?: number } = {},
): FolderAdvice {
  const path = root.path;
  switch (root.validationStatus) {
    case 'pending': {
      const waited = (opts.now ?? Date.now()) - Date.parse(root.createdAt);
      // Workers are running, but none of them takes folder checks (they are
      // done by the worker that scans, the one that can see the files).
      if (opts.workerLive !== false && opts.checkerLive === false) {
        return {
          tone: 'warning',
          title: 'No running worker checks folders',
          text: 'Start the file worker (worker-files).',
        };
      }
      if (opts.workerLive === false || (opts.workerLive === undefined && waited > PENDING_GRACE_MS * 3)) {
        return {
          tone: 'warning',
          title: 'No worker has checked this folder yet',
          text: 'Start the worker.',
        };
      }
      return { tone: 'info', title: 'Checking the folder', text: '' };
    }
    case 'missing':
      return {
        tone: 'danger',
        title: 'The worker cannot find this folder',
        text: `${path} does not exist on the worker host. Mount it there (NFS or SMB for a NAS), then Re-check.`,
      };
    case 'not_directory':
      return {
        tone: 'danger',
        title: 'This is a file, not a folder',
        text: `Enter the folder that holds your artist folders.`,
      };
    case 'unreadable':
      return {
        tone: 'danger',
        title: 'The worker cannot open this folder',
        text: `Give the worker user read access to ${path}, then Re-check.`,
      };
    case 'ok':
      if (root.validationMessage === SCAN_ROOT_EMPTY_MESSAGE) {
        return {
          tone: 'warning',
          title: 'The worker sees an empty folder',
          text: `Docker is not sharing ${path} with the worker. On a Mac, keep the music under your home folder, then Re-check.`,
        };
      }
      if (root.writable && root.probeWritable === false) {
        return {
          tone: 'warning',
          title: 'Readable, but read-only',
          text: 'Tag changes can’t be written to these files.',
        };
      }
      return { tone: 'success', title: 'Folder is ready', text: '' };
  }
}
