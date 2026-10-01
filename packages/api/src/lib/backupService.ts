/**
 * Database backups run by the app: the nightly pg-boss schedule and "Back up
 * now". The app owns this because its image ships pg_dump/pg_restore and
 * mounts the backups folder; the workers have neither.
 *
 * One backup at a time per app process: a request that arrives while one is
 * running waits for it and then runs its own.
 */
import type PgBoss from 'pg-boss';
import {
  defaultBackupDir,
  readBackupSettings,
  runRecordedBackup,
  type BackupRunRecord,
  type BackupSettings,
} from '@liner/doctor';

export const BACKUP_QUEUE = 'backup.nightly';

type RunFn = typeof runRecordedBackup;

interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface BackupServiceOptions {
  databaseUrl: string;
  env?: NodeJS.ProcessEnv;
  /** Replaced in tests. */
  run?: RunFn;
}

export function nightlyCron(settings: BackupSettings): string {
  return `0 ${settings.hour} * * *`;
}

export class BackupService {
  readonly dir: string;
  /** The folder was named on purpose (BACKUP_DIR / LINER_BACKUP_DIR), not the fallback inside the cache. */
  readonly dedicated: boolean;
  readonly timeZone: string;
  private readonly databaseUrl: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runFn: RunFn;
  private chain: Promise<unknown> = Promise.resolve();
  private active = 0;

  constructor(opts: BackupServiceOptions) {
    this.env = opts.env ?? process.env;
    this.databaseUrl = opts.databaseUrl;
    this.dir = defaultBackupDir(this.env);
    this.dedicated = !!(this.env['BACKUP_DIR'] || this.env['LINER_BACKUP_DIR']);
    this.timeZone = this.env['TZ'] || 'UTC';
    this.runFn = opts.run ?? runRecordedBackup;
  }

  get running(): boolean {
    return this.active > 0;
  }

  settings(): Promise<BackupSettings> {
    return readBackupSettings(this.dir, this.env);
  }

  /** Queue one backup behind any that is running; resolves with its outcome (a failure is a record, not a throw). */
  run(kind: 'nightly' | 'manual'): Promise<BackupRunRecord> {
    this.active++;
    const next = this.chain.then(async () => {
      const settings = await this.settings();
      return this.runFn({
        databaseUrl: this.databaseUrl,
        dir: this.dir,
        kind,
        policy: { keepDaily: settings.keepDaily, keepWeekly: settings.keepWeekly },
        timeZone: this.timeZone,
      });
    });
    const done = next.finally(() => { this.active--; });
    this.chain = done.catch(() => undefined);
    return done;
  }
}

/** (Re)apply the nightly schedule from the saved settings: on at the chosen hour, or off. */
export async function applyBackupSchedule(boss: PgBoss, service: BackupService, settings?: BackupSettings): Promise<void> {
  const s = settings ?? (await service.settings());
  if (s.enabled) {
    await boss.schedule(BACKUP_QUEUE, nightlyCron(s), {}, { tz: service.timeZone, singletonKey: BACKUP_QUEUE });
  } else {
    await boss.unschedule(BACKUP_QUEUE);
  }
}

/** Create the queue, work it in this process, and apply the schedule. */
export async function startBackupScheduler(boss: PgBoss, service: BackupService, logger: Logger): Promise<void> {
  await boss.createQueue(BACKUP_QUEUE, { retryLimit: 0, expireInSeconds: 6 * 3600 });
  await boss.work(BACKUP_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      logger.info({ jobId: job.id }, 'nightly backup start');
      const record = await service.run('nightly');
      if (record.ok) logger.info({ file: record.file, pruned: record.pruned }, 'nightly backup written');
      else logger.error({ error: record.error }, 'nightly backup failed');
    }
  });
  await applyBackupSchedule(boss, service);
}
