/**
 * The music mount read from the host mount table, and the verdict that tells
 * a dead network share from slow work, then the prober that reads them
 * through a fake Docker and a fake network. The only file is a fake .env in a
 * temp folder.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as shared from '@tagave/shared/mounts';
import { MUSIC_SERVICES } from './music-heal.js';
import {
  cachedProber,
  decodeMountPath,
  hostConnectArgs,
  MUSIC_BOUND,
  musicMount,
  musicProber,
  musicVerdict,
  mountinfoArgs,
  probeServer,
  PROBE_HELPER_PREFIX,
  sharePort,
  tcpConnect,
  validServer,
} from './music-probe.js';
import { assertAllowed } from './argv-guard.testkit.js';
import type { CommandResult, Runner } from './runner.js';

/** One real /proc/self/mountinfo line. */
function line(mountPoint: string, fstype: string, source: string, opts: string): string {
  return `36 25 0:52 / ${mountPoint} rw,relatime shared:1 - ${fstype} ${source} ${opts}\n`;
}

const NFS = line('/mnt/music', 'nfs4', '192.0.2.10:/export/music', 'rw,vers=4.2,hard,proto=tcp');
const ROOT = line('/', 'ext4', '/dev/sda1', 'rw');

describe('musicMount', () => {
  it('nfs4 hard', () =>
    expect(musicMount(ROOT + NFS, '/mnt/music')).toEqual({ kind: 'network', fstype: 'nfs4', server: '192.0.2.10', export: '/export/music', hard: true, mountPoint: '/mnt/music' }));
  it('nfs soft', () => expect(musicMount(ROOT + line('/mnt/music', 'nfs', '192.0.2.10:/m', 'rw,soft'), '/mnt/music').hard).toBe(false));
  it('cifs', () =>
    expect(musicMount(ROOT + line('/mnt/music', 'cifs', '//192.0.2.11/music', 'rw,vers=3.0'), '/mnt/music')).toMatchObject({ kind: 'network', server: '192.0.2.11', export: '/music', hard: false }));
  it('local ext4 mount point', () => expect(musicMount(ROOT + line('/mnt/music', 'ext4', '/dev/sdb1', 'rw'), '/mnt/music').kind).toBe('local'));
  it('a plain folder on the root disk', () => expect(musicMount(ROOT, '/srv/music')).toMatchObject({ kind: 'absent', mountPoint: '/' }));
  it('nested prefix', () => expect(musicMount(ROOT + line('/mnt/nas', 'nfs4', '192.0.2.10:/vol', 'rw'), '/mnt/nas/music')).toMatchObject({ kind: 'network', mountPoint: '/mnt/nas' }));
  it('a sibling is not a prefix', () => expect(musicMount(ROOT + line('/mnt/mus', 'nfs4', '192.0.2.10:/v', 'rw'), '/mnt/music').kind).toBe('absent'));
  it('escaped spaces', () => expect(musicMount(ROOT + line('/mnt/my\\040music', 'nfs4', '192.0.2.10:/v', 'rw'), '/mnt/my music').mountPoint).toBe('/mnt/my music'));
  it('bad server text', () => {
    expect(musicMount(ROOT + line('/mnt/music', 'nfs4', '-oProxy=x:/v', 'rw'), '/mnt/music')).toMatchObject({ kind: 'network', server: null });
    expect(validServer('nas.example.com')).toBe('nas.example.com');
    expect(validServer('[2001:db8::1]')).toBe('2001:db8::1');
    expect(validServer('192.0.2.10;rm')).toBeNull();
  });
  it('never returns the mount options', () =>
    expect(JSON.stringify(musicMount(ROOT + line('/mnt/music', 'cifs', '//192.0.2.11/m', 'username=robin,domain=x'), '/mnt/music'))).not.toContain('robin'));
});

/** The mount tables and folders above, so the shared copy can be held to them. */
const FIXTURES: [string, string][] = [
  [ROOT + NFS, '/mnt/music'],
  [ROOT + NFS, '/mnt/music/Jazz/'],
  [ROOT + line('/mnt/music', 'nfs', '192.0.2.10:/m', 'rw,soft'), '/mnt/music'],
  [ROOT + line('/mnt/music', 'cifs', '//192.0.2.11/music', 'rw,vers=3.0'), '/mnt/music'],
  [ROOT + line('/mnt/music', 'cifs', '//192.0.2.11/m', 'username=robin,domain=x'), '/mnt/music'],
  [ROOT + line('/mnt/music', 'ext4', '/dev/sdb1', 'rw'), '/mnt/music'],
  [ROOT, '/srv/music'],
  ['', '/srv/music'],
  [ROOT + line('/mnt/nas', 'nfs4', '192.0.2.10:/vol', 'rw'), '/mnt/nas/music'],
  [ROOT + line('/mnt/mus', 'nfs4', '192.0.2.10:/v', 'rw'), '/mnt/music'],
  [ROOT + line('/mnt/my\\040music', 'nfs4', '192.0.2.10:/v', 'rw'), '/mnt/my music'],
  [ROOT + line('/mnt/music', 'nfs4', '-oProxy=x:/v', 'rw'), '/mnt/music'],
];

describe('the shared copy', () => {
  it('the shared copy agrees with this one', () => {
    for (const [info, dir] of FIXTURES) expect(shared.musicMount(info, dir)).toEqual(musicMount(info, dir));
    for (const s of ['192.0.2.10', '[2001:db8::1]', 'nas.example.com', '-oProxy', '192.0.2.10;rm']) expect(shared.validServer(s)).toBe(validServer(s));
    for (const t of ['nfs', 'nfs4', 'cifs', 'smb3', 'ext4']) expect(shared.sharePort(t)).toBe(sharePort(t));
    expect(shared.decodeMountPath('/a\\040b\\011c\\012d\\134e')).toBe(decodeMountPath('/a\\040b\\011c\\012d\\134e'));
  });
});

describe('helpers', () => {
  it('decodes the mountinfo octal escapes', () => expect(decodeMountPath('/a\\040b\\011c\\012d\\134e')).toBe('/a b\tc\nd\\e'));
  it('gives the share port per fstype', () => {
    expect([sharePort('nfs'), sharePort('nfs4'), sharePort('cifs'), sharePort('smb3'), sharePort('ext4')]).toEqual([2049, 2049, 445, 445, null]);
  });
  it('re-exports the music-bound services', () => expect(MUSIC_BOUND).toEqual([...MUSIC_SERVICES]));
});

describe('verdict', () => {
  const net = musicMount(ROOT + NFS, '/mnt/music');
  const stuck = [{ service: 'worker-files', stuck: true }];
  it.each([
    [net, 'silent', stuck, null, 'music_unreachable'],
    [net, 'answers', stuck, null, 'ok'],
    [net, 'silent', [{ service: 'worker-identify', stuck: true }], null, 'ok'],
    [net, 'unknown', stuck, null, 'ok'],
    [musicMount(ROOT, '/srv/music'), null, [], true, 'music_unmounted'],
    [musicMount(ROOT, '/srv/music'), null, [], false, 'ok'],
  ] as const)('%#', (m, a, p, u, want) => expect(musicVerdict(m, a, [...p], u)).toBe(want));
});

const IMAGE = `sha256:${'a'.repeat(64)}`;
const noSleep = async () => {};

describe('probeServer', () => {
  it('answers on the first connect', async () => expect(await probeServer('192.0.2.10', 2049, { connect: async () => true })).toBe('answers'));
  it('is silent after 3 tries and a silent host check, in about 10 s', async () => {
    let slept = 0;
    const tries: number[] = [];
    const r = await probeServer('192.0.2.10', 2049, {
      connect: async (_h, _p, t) => { tries.push(t); return false; },
      sleep: async (ms) => { slept += ms; },
      hostCheck: async () => false,
    });
    expect(r).toBe('silent');
    expect(tries).toEqual([3000, 3000, 3000]);
    expect(slept).toBe(1000);
  });
  it('trusts the host network when the container cannot reach the share', async () =>
    expect(await probeServer('192.0.2.10', 2049, { connect: async () => false, sleep: noSleep, hostCheck: async () => true })).toBe('answers'));
  it('a host check with no answer is silent', async () =>
    expect(await probeServer('192.0.2.10', 2049, { connect: async () => false, sleep: noSleep, hostCheck: async () => null })).toBe('silent'));
  it('slow DNS gives unknown', async () => expect(await probeServer('nas.example.com', 2049, { resolve: async () => null, connect: async () => true })).toBe('unknown'));
  it('a name that does not resolve takes the host check answer', async () => {
    expect(await probeServer('nas.example.com', 2049, { resolve: async () => null, hostCheck: async () => true })).toBe('answers');
    expect(await probeServer('nas.example.com', 2049, { resolve: async () => null, hostCheck: async () => false })).toBe('silent');
    expect(await probeServer('nas.example.com', 2049, { resolve: async () => null, hostCheck: async () => null })).toBe('unknown');
  });
  it('resolves a name in 3 s and connects to the address it gives', async () => {
    const seen: Array<[string, number]> = [];
    const r = await probeServer('nas.example.com', 445, {
      resolve: async (h, t) => { seen.push([h, t]); return '192.0.2.11'; },
      connect: async (h, p) => h === '192.0.2.11' && p === 445,
    });
    expect(r).toBe('answers');
    expect(seen).toEqual([['nas.example.com', 3000]]);
  });
  it('does not resolve an address', async () => {
    let resolved = 0;
    await probeServer('192.0.2.10', 2049, { resolve: async () => { resolved++; return null; }, connect: async () => true });
    await probeServer('2001:db8::1', 2049, { resolve: async () => { resolved++; return null; }, connect: async () => true });
    expect(resolved).toBe(0);
  });
  it('a connector that throws counts as a failed try', async () =>
    expect(await probeServer('192.0.2.10', 2049, { connect: async () => { throw new Error('x'); }, sleep: noSleep, hostCheck: async () => false })).toBe('silent'));
});

describe('helper argv', () => {
  it('reads the host mount table, nothing else', () =>
    expect(mountinfoArgs(IMAGE, 'tagave-music-probe-1')).toEqual(['run', '--rm', '--privileged', '--pid=host', '--name', 'tagave-music-probe-1', '--entrypoint', 'nsenter', IMAGE, '-t', '1', '-m', '--', 'cat', '/proc/self/mountinfo']));
  it('checks the port from the host network', () =>
    expect(hostConnectArgs(IMAGE, 'tagave-music-probe-2', '192.0.2.10', 2049)).toEqual(['run', '--rm', '--network', 'host', '--name', 'tagave-music-probe-2', '--entrypoint', 'nc', IMAGE, '-z', '-w', '3', '192.0.2.10', '2049']));
});

/** A Docker that answers from a script, keyed by the command it gets. */
function fakeDocker(answer: (args: string[]) => Partial<CommandResult>): { docker: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const docker: Runner = async (args) => {
    assertAllowed(args);
    calls.push(args);
    return { code: 0, stdout: '', stderr: '', ...answer(args) };
  };
  return { docker, calls };
}

/** Self is this image, the host has the NFS share, and the host nc says `nc`. */
function hostWith(over: { mountinfo?: Partial<CommandResult>; nc?: Partial<CommandResult>; inspect?: Partial<CommandResult> } = {}) {
  return (args: string[]): Partial<CommandResult> => {
    if (args[0] === 'inspect') return over.inspect ?? { stdout: `${IMAGE}\n` };
    if (args.includes('/proc/self/mountinfo')) return over.mountinfo ?? { stdout: ROOT + NFS };
    if (args.includes('nc')) return over.nc ?? { code: 1 };
    return { code: 1 };
  };
}

async function installWith(env: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'music-probe-'));
  await writeFile(join(dir, '.env'), env);
  return dir;
}

const stuckFiles = [{ service: 'worker-files', stuck: true }];

describe('musicProber (fake Docker, fake network)', () => {
  it('reads the mount table through the helper and checks the share', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const { docker, calls } = fakeDocker(hostWith());
    let n = 0;
    const prober = musicProber({ installDir, docker, self: 'self-id', connect: async () => false, sleep: noSleep, name: () => `tagave-music-probe-${++n}` });
    const reading = await prober.read({ parts: stuckFiles });
    expect(reading).toMatchObject({ dir: '/mnt/music', verdict: 'music_unreachable', server: '192.0.2.10', answer: 'silent' });
    expect(reading?.mount).toMatchObject({ kind: 'network', fstype: 'nfs4' });
    expect(calls[0]).toEqual(['inspect', '--format', '{{.Image}}', 'self-id']);
    expect(calls.find((c) => c.includes('cat'))).toEqual(mountinfoArgs(IMAGE, 'tagave-music-probe-1'));
    expect(calls.find((c) => c.includes('nc'))).toEqual(hostConnectArgs(IMAGE, 'tagave-music-probe-2', '192.0.2.10', 2049));
    // nothing ever names MUSIC_DIR in an argv
    expect(calls.flat()).not.toContain('/mnt/music');
  });

  it('passes the limits: 15 s for the mount table, 10 s for the host check', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const limits: Array<[string, number | undefined]> = [];
    const docker: Runner = async (args, opts) => {
      assertAllowed(args);
      limits.push([args.includes('nc') ? 'nc' : args.includes('cat') ? 'cat' : args[0]!, opts?.timeoutMs]);
      return { code: 0, stdout: '', stderr: '', ...hostWith()(args) };
    };
    await musicProber({ installDir, docker, self: 's', connect: async () => false, sleep: noSleep }).read({ parts: [] });
    expect(limits).toEqual([['inspect', 30_000], ['cat', 15_000], ['nc', 10_000]]);
  });

  it('a share that answers is ok, and the host is not asked', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const { docker, calls } = fakeDocker(hostWith());
    const reading = await musicProber({ installDir, docker, self: 's', connect: async () => true }).read({ parts: stuckFiles });
    expect(reading).toMatchObject({ answer: 'answers', verdict: 'ok' });
    expect(calls.some((c) => c.includes('nc'))).toBe(false);
  });

  it('the host check: exit 0 answers, exit 1 is silent, anything else is no answer', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const answer = async (nc: Partial<CommandResult>) =>
      (await musicProber({ installDir, docker: fakeDocker(hostWith({ nc })).docker, self: 's', connect: async () => false, sleep: noSleep }).read({ parts: stuckFiles }))?.answer;
    expect(await answer({ code: 0 })).toBe('answers');
    expect(await answer({ code: 1 })).toBe('silent');
    expect(await answer({ code: 125 })).toBe('silent');
  });

  it('a host check whose docker call throws is no answer, not a throw', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const docker: Runner = async (args) => {
      assertAllowed(args);
      if (args.includes('nc')) throw new Error('spawn failed');
      return { code: 0, stdout: '', stderr: '', ...hostWith()(args) };
    };
    expect(await musicProber({ installDir, docker, self: 's', connect: async () => false, sleep: noSleep }).read({ parts: stuckFiles })).toMatchObject({ answer: 'silent' });
  });

  it('a local folder: no server, no probe, the app decides unmounted', async () => {
    const installDir = await installWith('MUSIC_DIR=/srv/music\n');
    const { docker, calls } = fakeDocker(hostWith({ mountinfo: { stdout: ROOT } }));
    const reading = await musicProber({ installDir, docker, self: 's', connect: async () => { throw new Error('no connect'); } }).read({ parts: [], appUnmounted: true });
    expect(reading).toMatchObject({ dir: '/srv/music', answer: null, server: null, verdict: 'music_unmounted', mount: { kind: 'absent' } });
    expect(calls.some((c) => c.includes('nc'))).toBe(false);
  });

  it('a network mount with a bad server is not probed', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const { docker } = fakeDocker(hostWith({ mountinfo: { stdout: ROOT + line('/mnt/music', 'nfs4', '-oProxy=x:/v', 'rw') } }));
    const reading = await musicProber({ installDir, docker, self: 's', connect: async () => { throw new Error('no connect'); } }).read({ parts: stuckFiles });
    expect(reading).toMatchObject({ answer: null, server: null, verdict: 'ok' });
  });

  it('gives every helper its own name', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const { docker, calls } = fakeDocker(hostWith());
    const prober = musicProber({ installDir, docker, self: 's', connect: async () => false, sleep: noSleep });
    await prober.read({ parts: [] });
    await prober.read({ parts: [] });
    const names = calls.filter((c) => c[0] === 'run').map((c) => c[c.indexOf('--name') + 1]!);
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => /^tagave-music-probe-[0-9a-f]{8}$/.test(n))).toBe(true);
    expect(PROBE_HELPER_PREFIX).toBe('tagave-music-probe');
  });

  it('returns null when the helper cannot run', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const prober = musicProber({ installDir, docker: fakeDocker(hostWith({ mountinfo: { code: 125, stderr: 'no such image' } })).docker, self: 's' });
    expect(await prober.read({ parts: [] })).toBeNull();
  });

  it('returns null when Docker cannot say which image this is, or throws', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    expect(await musicProber({ installDir, docker: fakeDocker(hostWith({ inspect: { stdout: 'not-an-id\n' } })).docker, self: 's' }).read({ parts: [] })).toBeNull();
    expect(await musicProber({ installDir, docker: async () => { throw new Error('spawn failed'); }, self: 's' }).read({ parts: [] })).toBeNull();
  });

  it('returns null without MUSIC_DIR, and runs nothing', async () => {
    const installDir = await installWith('COMPOSE_PROJECT_NAME=tagave\n');
    const { docker, calls } = fakeDocker(hostWith());
    const prober = musicProber({ installDir, docker, self: 's' });
    expect(await prober.read({ parts: [] })).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('cachedProber', () => {
  it('shares one reading within a minute', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const { docker, calls } = fakeDocker(hostWith());
    let t = 1_000_000;
    const prober = cachedProber(musicProber({ installDir, docker, self: 's', connect: async () => true }), () => t);
    const mountReads = () => calls.filter((c) => c.includes('/proc/self/mountinfo')).length;
    const [a, b] = await Promise.all([prober.read({ parts: [] }), prober.read({ parts: stuckFiles })]);
    expect(a).toEqual(b);
    expect(mountReads()).toBe(1);
    t += 59_000;
    await prober.read({ parts: [] });
    expect(mountReads()).toBe(1);
    t += 2_000;
    await prober.read({ parts: [] });
    expect(mountReads()).toBe(2);
  });

  it('shares a read that takes longer than the minute, and counts the minute from when it ends', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const calls: string[][] = [];
    const answer = hostWith();
    const docker: Runner = async (args) => {
      assertAllowed(args);
      calls.push(args);
      if (args.includes('/proc/self/mountinfo')) await held;
      return { code: 0, stdout: '', stderr: '', ...answer(args) };
    };
    let t = 1_000_000;
    const prober = cachedProber(musicProber({ installDir, docker, self: 's', connect: async () => true }), () => t);
    const mountReads = () => calls.filter((c) => c.includes('/proc/self/mountinfo')).length;
    const first = prober.read({ parts: [] });
    await vi.waitFor(() => expect(mountReads()).toBe(1));
    t += 61_000;
    const second = prober.read({ parts: [] });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ answer: 'answers' });
    expect(b).toEqual(a);
    expect(mountReads()).toBe(1);
    // the minute counts from when the read ended, not when it began
    t += 59_000;
    await prober.read({ parts: [] });
    expect(mountReads()).toBe(1);
    t += 2_000;
    await prober.read({ parts: [] });
    expect(mountReads()).toBe(2);
  });

  it('keeps a failed reading for the minute too', async () => {
    let reads = 0;
    let t = 0;
    const prober = cachedProber({ read: async () => { reads++; return null; } }, () => t);
    expect(await prober.read({ parts: [] })).toBeNull();
    expect(await prober.read({ parts: [] })).toBeNull();
    expect(reads).toBe(1);
    t = 60_000;
    await prober.read({ parts: [] });
    expect(reads).toBe(2);
  });
});

describe('cachedProber verdicts', () => {
  it('works out the verdict for each caller from the shared reading', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const { docker, calls } = fakeDocker(hostWith());
    const prober = cachedProber(musicProber({ installDir, docker, self: 's', connect: async () => false, sleep: noSleep }), () => 0);
    const [idle, stuck] = await Promise.all([prober.read({ parts: [] }), prober.read({ parts: stuckFiles })]);
    expect(idle).toMatchObject({ answer: 'silent', verdict: 'ok' });
    expect(stuck).toMatchObject({ answer: 'silent', verdict: 'music_unreachable' });
    expect(calls.filter((c) => c.includes('/proc/self/mountinfo'))).toHaveLength(1);
  });
});

describe('tcpConnect', () => {
  it('true when the port answers, false when nothing listens', async () => {
    const server = createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    expect(await tcpConnect('127.0.0.1', port, 1000)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await tcpConnect('127.0.0.1', port, 1000)).toBe(false);
  });
});
