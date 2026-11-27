/**
 * The watch's look at a root through the file gate (gateProbe): the gate's
 * helpers do the fs calls on the share, and the gate can always give up on
 * them. The cases of PR1's one-shot probe child, moved to the gate. The real
 * helper is built JS, so run `pnpm --filter @tagave/worker build` first; the
 * fake helper (testkit/fakeHelper.mjs) stands in for a dead share (`hang`).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FileGate } from '../fileGate.js';
import { portAnswers } from './port.js';
import { gateProbe, MAX_KNOWN } from './probe.js';
import { classify } from './reach.js';

const FAKE = fileURLToPath(new URL('../../testkit/fakeHelper.mjs', import.meta.url));

const made: string[] = [];
const gates: FileGate[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'offlinetest-'));
  made.push(dir);
  return dir;
}
function gate(opts: ConstructorParameters<typeof FileGate>[0] = {}): FileGate {
  const g = new FileGate({ ...opts, limits: { waitMs: 300, idleMs: 1_500, helpers: 2, stuckMax: 4, ...opts.limits } });
  gates.push(g);
  return g;
}
afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.close()));
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

/** Resources that keep the event loop alive, by type. */
function alive(): Record<string, number> {
  const n: Record<string, number> = {};
  for (const t of process.getActiveResourcesInfo()) n[t] = (n[t] ?? 0) + 1;
  return n;
}

describe('gateProbe', () => {
  it('answers for a readable folder', async () => {
    const dir = await tempDir(); await writeFile(join(dir, 'a.flac'), 'x');
    expect(await gateProbe(gate(), 'r1', dir, ['a.flac'])).toMatchObject({ kind: 'listing', empty: false, knownFound: 1, knownAsked: 1 });
  });

  it('gives up on a helper that hangs, and the parent keeps working', async () => {
    const t = Date.now();
    expect(await gateProbe(gate({ helperPath: FAKE }), 'r1', 'hang', [])).toEqual({ kind: 'deadline' });
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(await readFile(__filename, 'utf8')).toContain('gives up'); // the parent's fs is free
  });

  it('reads a deadline, forking nothing, while the root\'s last probe helper has not exited', async () => {
    let second: Promise<unknown> | null = null;
    const g: FileGate = gate({ helperPath: FAKE, onSuspect: (id) => { second ??= gateProbe(g, id, 'ok', []); } });
    expect(await gateProbe(g, 'r1', 'hang', [])).toEqual({ kind: 'deadline' });
    expect(await second).toEqual({ kind: 'deadline' });
  });

  it('a hung helper it gave up on keeps nothing of the parent alive', async () => {
    const g = gate({ helperPath: FAKE });
    await settle();
    const before = alive();
    expect(await gateProbe(g, 'r1', 'hang', [])).toEqual({ kind: 'deadline' });
    // Read at once: a helper stuck on a real dead share may never exit, so its handle must already be let go.
    const after = alive();
    expect(after.Timeout ?? 0).toBeLessThanOrEqual(before.Timeout ?? 0);
    await settle();
    expect(alive().PipeWrap ?? 0).toBeLessThanOrEqual((before.PipeWrap ?? 0) + 1); // at most the fresh, idle helper
  });

  it('leaves no timer behind after an answer', async () => {
    const dir = await tempDir();
    const g = gate({ limits: { waitMs: 60_000 } });
    await gateProbe(g, 'r1', dir, []); // the helper is forked once
    await settle();
    const before = alive();
    expect(await gateProbe(g, 'r1', dir, [])).toMatchObject({ kind: 'listing' });
    const after = alive();
    expect(after.Timeout ?? 0).toBeLessThanOrEqual(before.Timeout ?? 0);
    expect(after.ProcessWrap ?? 0).toBeLessThanOrEqual(before.ProcessWrap ?? 0);
  });

  it('reads an empty folder, and counts known files that are gone', async () => {
    const dir = await tempDir();
    const g = gate();
    expect(await gateProbe(g, 'r1', dir, [])).toEqual({ kind: 'listing', empty: true, knownFound: 0, knownAsked: 0, isMountPoint: false, wasMountPoint: false });
    await writeFile(join(dir, 'b.flac'), 'x');
    expect(await gateProbe(g, 'r1', dir, ['b.flac', 'Jazz/gone.flac', 'gone.flac', 'b.flac/under'])).toEqual({
      kind: 'listing', empty: false, knownFound: 1, knownAsked: 4, isMountPoint: false, wasMountPoint: false,
    });
  });

  it('passes on the error code when the folder is not there, which reads offline', async () => {
    const dir = await tempDir();
    const out = await gateProbe(gate(), 'r1', join(dir, 'nope'), ['a.flac']);
    expect(out).toEqual({ kind: 'error', code: 'ENOENT' });
    expect(classify(out)).toEqual({ reach: 'offline', reason: 'io_error' });
  });

  it('an offline code from the share is passed on as that code', async () => {
    const out = await gateProbe(gate({ helperPath: FAKE }), 'r1', 'eio', []);
    expect(out).toEqual({ kind: 'error', code: 'EIO' });
    expect(classify(out)).toEqual({ reach: 'offline', reason: 'io_error' });
  });

  it('a helper that exits without answering, or answers nonsense, reads as an error, never online', async () => {
    const dir = await tempDir();
    const quitter = join(dir, 'quit.mjs');
    await writeFile(quitter, 'process.exit(0);\n');
    expect(await gateProbe(gate({ helperPath: quitter, limits: { waitMs: 5_000 } }), 'r1', dir, [])).toEqual({ kind: 'error', code: 'EHELPER' });
    const garbled = join(dir, 'garbled.mjs');
    await writeFile(garbled, "process.on('message', (m) => process.send({ id: m.id, ok: 'yes' }));\n");
    expect(await gateProbe(gate({ helperPath: garbled, limits: { waitMs: 5_000 } }), 'r1', dir, [])).toEqual({ kind: 'error', code: 'EHELPER' });
  });

  it('a helper path that does not load is an error, not a missing folder', async () => {
    const dir = await tempDir();
    const out = await gateProbe(gate({ helperPath: join(dir, 'missing.js'), limits: { waitMs: 5_000 } }), 'r1', dir, []);
    expect(out).toEqual({ kind: 'error', code: 'EHELPER' });
    expect(classify(out).reach).toBe('offline');
  });

  it('asks about at most 5 known files', async () => {
    const dir = await tempDir();
    const names = Array.from({ length: 8 }, (_, i) => `t${i}.flac`);
    await Promise.all(names.map((n) => writeFile(join(dir, n), 'x')));
    expect(MAX_KNOWN).toBe(5);
    expect(await gateProbe(gate(), 'r1', dir, names)).toMatchObject({ kind: 'listing', knownFound: 5, knownAsked: 5 });
  });

  it('a closed gate (shutdown) throws EGATECLOSED: no reading at all, neither an error nor a deadline', async () => {
    const dir = await tempDir();
    const g = gate();
    await g.close();
    await expect(gateProbe(g, 'r1', dir, [])).rejects.toMatchObject({ code: 'EGATECLOSED' });
    // closed while a call is in flight: the same
    const h = gate({ helperPath: FAKE, limits: { waitMs: 5_000 } });
    const probing = gateProbe(h, 'r1', 'hang', []).then(() => 'answered', (e: unknown) => e);
    await settle();
    await h.close();
    expect(await probing).toMatchObject({ code: 'EGATECLOSED' });
  });

  it('passes the gate\'s stuck cap: a root at its cap can still read online', async () => {
    const dir = await tempDir();
    const g = gate({ limits: { stuckMax: 1 } });
    g.markStuck('r1');
    expect(g.refuses('r1')).toBe(true);
    expect(await gateProbe(g, 'r1', dir, [])).toMatchObject({ kind: 'listing' });
  });
});

describe('portAnswers', () => {
  it('the port check gives up after two tries', async () => {
    const tries: number[] = [];
    expect(await portAnswers('192.0.2.10', 2049, { connect: async (_h, _p, t) => { tries.push(t); return false; }, gapMs: 0 })).toBe(false);
    expect(tries).toEqual([3000, 3000]);
  });

  it('stops at the first answer, and a throwing connect counts as silent', async () => {
    let n = 0;
    const connect = async () => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return true;
    };
    expect(await portAnswers('192.0.2.10', 445, { connect, gapMs: 0, tries: 3 })).toBe(true);
    expect(n).toBe(2);
  });

  it('waits the gap between tries, not after the last', async () => {
    const t = Date.now();
    expect(await portAnswers('192.0.2.10', 2049, { connect: async () => false, gapMs: 200 })).toBe(false);
    const took = Date.now() - t;
    expect(took).toBeGreaterThanOrEqual(190);
    expect(took).toBeLessThan(380);
  });
});
