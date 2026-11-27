/**
 * Real I/O progress of a process, from /proc/<pid>/io (Linux; local procfs,
 * never the share). A process blocked on a dead share moves no bytes; one
 * working on a slow live share does, even when it writes nothing to its
 * pipes. Used by the file helper (its own reads), spawnGuarded (a child
 * tool's reads) and the tag writer (its sidecar's reads and writes).
 *
 * Where /proc/<pid>/io is missing (macOS, or the process has exited) there
 * is no sample and no progress: the deadlines are then plain deadlines.
 */
import { readFileSync } from 'node:fs';

/** Bytes moved since the last progress before the next one counts: the event loop's own small reads (8-byte eventfd wakeups) do not. */
export const PROGRESS_MIN_BYTES = 64 * 1024;

/** How often a sampler looks: 5 s, or a third of a shorter deadline so a sample lands inside it. */
export function sampleMs(deadlineMs: number): number {
  return Math.min(5_000, Math.max(50, Math.floor(deadlineMs / 3)));
}

export type IoField = 'rchar' | 'wchar';

interface Sample {
  /** The fields' total as the file showed it. */
  shown: number;
  /** Where the next sample's growth starts: for /proc/self, past this read of the file itself. */
  after: number;
}

/** One sample of /proc/<pid>/io, or null where there is none. */
function sample(pid: number | 'self', fields: readonly IoField[]): Sample | null {
  try {
    const text = readFileSync(`/proc/${pid}/io`);
    const s = text.toString('utf8');
    let shown = 0;
    for (const f of fields) {
      const m = new RegExp(`^${f}:\\s*(\\d+)`, 'm').exec(s);
      if (!m) return null;
      shown += Number(m[1]);
    }
    // Reading /proc/self/io is a read too, counted after the text was made:
    // leave it out. Reading another process's file adds nothing to its counts.
    const own = pid === 'self' && fields.includes('rchar') ? text.length : 0;
    return { shown, after: shown + own };
  } catch {
    return null;
  }
}

/** Progress of one process: `grew()` is true each time at least `minBytes` more moved. */
export class IoProgress {
  private last: number | null;
  private moved = 0;

  constructor(
    readonly pid: number | 'self',
    private readonly fields: readonly IoField[] = ['rchar'],
    private readonly minBytes = PROGRESS_MIN_BYTES,
  ) {
    this.last = sample(pid, fields)?.after ?? null;
  }

  /** False where the process has no /proc io file (macOS, or gone). */
  get available(): boolean {
    return this.last !== null;
  }

  /** The fields' total at the last sample, or null. */
  get total(): number | null {
    return this.last;
  }

  /** Samples now: true when at least `minBytes` moved since the last true. No sample (exited) is no change. */
  grew(): boolean {
    const now = sample(this.pid, this.fields);
    if (now === null) return false;
    if (this.last === null) {
      this.last = now.after;
      return false;
    }
    this.moved += Math.max(0, now.shown - this.last);
    this.last = now.after;
    if (this.moved < this.minBytes) return false;
    this.moved = 0;
    return true;
  }
}
