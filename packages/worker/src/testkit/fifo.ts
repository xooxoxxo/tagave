/**
 * A folder that hangs like a dead hard NFS share: it holds a FIFO that no
 * one writes, so opening it for reading blocks in the kernel. `stat` and a
 * listing still answer. Needs `mkfifo` (macOS, Linux).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function deadFolder(): Promise<{ dir: string; fifo: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'offlinetest-'));
  const fifo = join(dir, 'pipe');
  try {
    await run('mkfifo', [fifo]);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  // rm unlinks the FIFO without opening it, so cleanup never blocks.
  return { dir, fifo, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
