/**
 * One repair or music self-heal at a time on an install, across processes.
 * The updater service (Repair button, a held update's repair, the self-heal
 * timer) and the installer's one-off (cli.js repair) move the same parts;
 * each process already keeps its own runs apart (the service's claim, the
 * healer's queue), and this file keeps the processes apart.
 *
 * .updater/repair.lock is created exclusively (O_EXCL) by whoever starts and
 * removed when it ends. The holder writes the time into it again every
 * beatMs. A lock whose time is older than staleMs was left by a process that
 * died without letting go (SIGKILL, a host restart) and is taken over: a hard
 * link to it is read, and the path removed only when it still holds the file
 * that looked stale, so the path is never empty while another taker looks.
 *
 * A caller that finds the lock held is told who holds it ("repair" or
 * "heal") and does nothing: that is "already running", never a failure.
 */
import { randomUUID } from 'node:crypto';
import { link, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdirKeepingOwner } from './safe-write.js';

export const REPAIR_LOCK_FILE = '.updater/repair.lock';

/** Who holds the lock: a repair (any trigger) or a self-heal attempt. */
export type LockHolder = 'repair' | 'heal';

/** Ends a hold: removes the lock when it is still this one. Safe to call twice. */
export type Release = () => Promise<void>;

/** Not taken: `holder` has it; null when the lock cannot be written here at all. */
export type LockAttempt = { ok: true; release: Release } | { ok: false; holder: LockHolder | null };

interface LockBody {
  token: string;
  holder: LockHolder;
  /** When the holder last wrote it (ISO). */
  at: string;
}

export interface RepairLockOptions {
  installDir: string;
  now?: () => number;
  /** A lock not written for this long is left over and taken over (default 90 s). */
  staleMs?: number;
  /** How often a holder writes its time (default 20 s). */
  beatMs?: number;
}

const isCode = (err: unknown, code: string) => (err as NodeJS.ErrnoException)?.code === code;

export class RepairLock {
  private readonly path: string;
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly beatMs: number;

  constructor(private readonly opts: RepairLockOptions) {
    this.path = join(opts.installDir, REPAIR_LOCK_FILE);
    this.now = opts.now ?? Date.now;
    this.staleMs = opts.staleMs ?? 90_000;
    this.beatMs = opts.beatMs ?? 20_000;
  }

  /** Takes the lock for `holder`, or says who has it. Never throws: a lock that cannot be written is not taken. */
  async acquire(holder: LockHolder): Promise<LockAttempt> {
    try {
      await mkdirKeepingOwner(join(this.opts.installDir, '.updater'), 0o700);
      // Twice: once more after a lock that was released, or was stale, in between.
      for (let attempt = 0; attempt < 2; attempt++) {
        const body: LockBody = { token: randomUUID(), holder, at: new Date(this.now()).toISOString() };
        try {
          await writeFile(this.path, JSON.stringify(body), { flag: 'wx', mode: 0o600 });
          return { ok: true, release: this.hold(body) };
        } catch (err) {
          if (!isCode(err, 'EEXIST')) return { ok: false, holder: null };
        }
        const seen = await this.read(this.path);
        if (seen === 'missing') continue;
        // A body that cannot be read (half written) counts as a repair's.
        if (!(await this.stale(seen))) return { ok: false, holder: seen?.holder ?? 'repair' };
        if (!(await this.takeOver(seen))) return { ok: false, holder: seen?.holder ?? 'repair' };
      }
      // Taken over twice in a row by others: someone has it.
      return { ok: false, holder: 'repair' };
    } catch {
      /* the folder cannot be written: not taken */
    }
    return { ok: false, holder: null };
  }

  /** The lock's body; null when it cannot be read as one (half written, or not ours); 'missing' when there is none. */
  private async read(path: string): Promise<LockBody | null | 'missing'> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      return isCode(err, 'ENOENT') ? 'missing' : null;
    }
    try {
      const b = JSON.parse(text) as Partial<LockBody>;
      return typeof b.token === 'string' && (b.holder === 'repair' || b.holder === 'heal') && typeof b.at === 'string' ? (b as LockBody) : null;
    } catch {
      return null;
    }
  }

  /** Not written for staleMs: by its time, or (a body that cannot be read) by the file's own. */
  private async stale(seen: LockBody | null): Promise<boolean> {
    let at = seen ? Date.parse(seen.at) : NaN;
    if (Number.isNaN(at)) at = await stat(this.path).then((s) => s.mtimeMs, () => this.now());
    return this.now() - at >= this.staleMs;
  }

  /**
   * Removes the stale lock without ever leaving the path empty while it is
   * looked at: a second name for the file at the path (a hard link), read;
   * the path is removed only when that file is still the one that looked
   * stale and is still the one at the path. A taker that comes second finds
   * the first one's fresh lock there and leaves it alone. True when the way
   * is clear to try again.
   */
  private async takeOver(seen: LockBody | null): Promise<boolean> {
    const aside = `${this.path}.${randomUUID()}.stale`;
    try {
      await link(this.path, aside);
    } catch {
      return true; // gone already: try again
    }
    try {
      const moved = await this.read(aside);
      if (moved === 'missing' || (moved?.token ?? null) !== (seen?.token ?? null)) return false;
      // Still the same file at the path (no taker replaced it in between)?
      const [atPath, ours] = await Promise.all([stat(this.path).catch(() => null), stat(aside)]);
      if (!atPath) return true;
      if (atPath.ino !== ours.ino || atPath.dev !== ours.dev) return false;
      await unlink(this.path).catch(() => undefined);
      return true;
    } finally {
      await unlink(aside).catch(() => undefined);
    }
  }

  /** Writes the time again every beatMs while it is still this lock; the release removes it. */
  private hold(body: LockBody): Release {
    let held = true;
    const beat = async () => {
      if (!held) return;
      const now = await this.read(this.path);
      if (now === 'missing' || now?.token !== body.token) {
        // Taken over (this process stalled past staleMs): it is no longer ours to write.
        held = false;
        clearInterval(timer);
        return;
      }
      // r+ never makes a new lock: a lock released or taken over in between stays so.
      await writeFile(this.path, JSON.stringify({ ...body, at: new Date(this.now()).toISOString() }), { flag: 'r+' }).catch(() => undefined);
    };
    const timer = setInterval(() => void beat().catch(() => undefined), this.beatMs);
    timer.unref();
    return async () => {
      if (!held) return;
      held = false;
      clearInterval(timer);
      const now = await this.read(this.path);
      if (now !== 'missing' && now?.token === body.token) await unlink(this.path).catch(() => undefined);
    };
  }
}
