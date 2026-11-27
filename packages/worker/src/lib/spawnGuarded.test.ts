import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fileGate } from './fileGate.js';
import { FolderOfflineError } from './folderOffline.js';
import { spawnGuarded } from './spawnGuarded.js';
import { guardedRunner } from './flacTools.js';

const dir = mkdtempSync(path.join(tmpdir(), 'spawnguarded-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Handles that keep the event loop alive, by kind. */
function liveHandles(kind: string): number {
  return process.getActiveResourcesInfo().filter((k) => k === kind).length;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('spawnGuarded', () => {
  it('lets a tool that keeps writing run past the idle deadline', async () => {
    const started = Date.now();
    const r = await spawnGuarded('sh', ['-c', 'for i in 1 2 3; do echo $i; sleep 1; done'], { rootId: 'root-busy', idleMs: 1500 });
    expect(r.code).toBe(0);
    expect(r.stdout.toString()).toBe('1\n2\n3\n');
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    expect(fileGate().stuckCount('root-busy')).toBe(0);
  }, 10_000);

  it('gives up on a hung tool at the wait deadline, counts it stuck and leaves no waited child', async () => {
    const pidFile = path.join(dir, 'sleep.pid');
    const processes = liveHandles('ProcessWrap');
    const before = fileGate().stuckCount('root-hung');
    const started = Date.now();
    const err = await spawnGuarded('sh', ['-c', `echo $$ > "${pidFile}"; exec sleep 30`], { rootId: 'root-hung', waitMs: 300 }).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(err).toBeInstanceOf(FolderOfflineError);
    expect((err as FolderOfflineError).scanRootId).toBe('root-hung');
    expect((err as FolderOfflineError).reason).toBe('timeout');
    expect(fileGate().stuckCount('root-hung')).toBe(before + 1);
    // Nothing of the child keeps the process up, and SIGKILL took it.
    expect(liveHandles('ProcessWrap')).toBeLessThanOrEqual(processes);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
    expect(alive(pid)).toBe(false);
    fileGate().clear('root-hung');
  });

  it('gives up at the idle deadline when a tool goes quiet', async () => {
    const started = Date.now();
    const err = await spawnGuarded('sh', ['-c', 'echo one; exec sleep 30'], { rootId: 'root-quiet', idleMs: 400 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FolderOfflineError);
    expect(Date.now() - started).toBeLessThan(1500);
    fileGate().clear('root-quiet');
  });

  it('feeds input and returns the exit code and stderr of a failing tool', async () => {
    const r = await spawnGuarded('sh', ['-c', 'cat; echo oops >&2; exit 3'], { rootId: 'root-io', input: Buffer.from('hello') });
    expect(r.code).toBe(3);
    expect(r.stdout.toString()).toBe('hello');
    expect(r.stderr.trim()).toBe('oops');
  });

  it('stops a runaway tool at maxStdout with code -1, not as offline', async () => {
    const r = await spawnGuarded('sh', ['-c', 'yes'], { rootId: 'root-big', maxStdout: 64 * 1024 });
    expect(r.code).toBe(-1);
    expect(fileGate().stuckCount('root-big')).toBe(0);
  });

  it('rejects a missing binary with ENOENT, not as offline', async () => {
    const err = await spawnGuarded('/nonexistent/tool', [], { rootId: 'root-missing' }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(FolderOfflineError);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it('streams stdout to onStdout instead of collecting it, and stops on its error', async () => {
    const seen: string[] = [];
    const r = await spawnGuarded('sh', ['-c', 'echo a; echo b'], { rootId: 'root-stream', onStdout: (d) => { seen.push(d.toString()); } });
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(0);
    expect(seen.join('')).toBe('a\nb\n');
    const err = await spawnGuarded('sh', ['-c', 'echo a; exec sleep 30'], { rootId: 'root-stream', onStdout: () => { throw new Error('bad chunk'); } })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe('bad chunk');
    expect(err).not.toBeInstanceOf(FolderOfflineError);
    expect(fileGate().stuckCount('root-stream')).toBe(0);
  });

  it('refuses a root at its stuck cap without spawning', async () => {
    for (let i = 0; i < 4; i++) fileGate().markStuck('root-capped');
    const started = Date.now();
    await expect(spawnGuarded('sh', ['-c', 'sleep 5'], { rootId: 'root-capped' })).rejects.toBeInstanceOf(FolderOfflineError);
    expect(Date.now() - started).toBeLessThan(200);
    fileGate().clear('root-capped');
    expect((await spawnGuarded('sh', ['-c', 'true'], { rootId: 'root-capped' })).code).toBe(0);
  });

  it('guardedRunner runs a binary for a root', async () => {
    const r = await guardedRunner('root-runner')('sh', ['-c', 'printf ok']);
    expect(r).toEqual({ code: 0, stdout: Buffer.from('ok'), stderr: '' });
  });
});
