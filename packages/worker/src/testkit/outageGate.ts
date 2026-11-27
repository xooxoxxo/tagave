/**
 * A FileGate for outage tests: the real gate (the built helper, so build
 * first) until the share goes down. Down, every op rejects with
 * FolderOfflineError for its root, as a dead share does at the gate's
 * deadline, without the wait. `cutAt` takes the share down when an op
 * matches, before that op runs: the cut-off point of a test.
 */
import { FileGate, type GateOp, type RunOptions } from '../lib/fileGate.js';
import { FolderOfflineError } from '../lib/folderOffline.js';

export class OutageGate extends FileGate {
  down = false;
  /** Every op asked, in order (`op` names). */
  readonly ops: string[] = [];
  /** Takes the share down when it returns true for an op (it sees the op's index among those of its kind). */
  cutAt: ((op: GateOp, nth: number) => boolean) | null = null;
  private readonly seen = new Map<string, number>();

  constructor() {
    super({ limits: { waitMs: 15_000, idleMs: 60_000, helpers: 2, stuckMax: 4 } });
  }

  override run<T>(rootId: string, op: GateOp, opts?: RunOptions): Promise<T> {
    this.ops.push(op.op);
    const nth = (this.seen.get(op.op) ?? 0) + 1;
    this.seen.set(op.op, nth);
    if (!this.down && this.cutAt?.(op, nth)) this.down = true;
    if (this.down && opts?.probe !== true) return Promise.reject(new FolderOfflineError(rootId, 'timeout'));
    return super.run<T>(rootId, op, opts);
  }

  /** The share is back; the counts start again. */
  up(): void {
    this.down = false;
    this.cutAt = null;
    this.seen.clear();
  }
}
