/**
 * The layout checks an update runs on the host: decideLayout against a table
 * that mirrors the installer's parent layout cases (scripts/test-installer.sh,
 * "the parent layout"), and readHostFacts through a fake Docker. No host fact
 * is read for real.
 */
import { describe, expect, it } from 'vitest';
import { assertAllowed } from './argv-guard.testkit.js';
import { envGet } from './envFile.js';
import {
  cheapRefusal,
  decideLayout,
  fstabTargets,
  LAYOUT_HELPER_PREFIX,
  layoutReason,
  mountPoints,
  parseDockerInfo,
  readHostFacts,
  withLayoutKeys,
  type HostFacts,
  type LayoutRefusal,
} from './music-layout.js';
import type { CommandResult, Runner, RunOptions } from './runner.js';

/** One /proc/self/mountinfo line; `point` is written as mountinfo escapes it. */
const mi = (id: number, point: string, fstype = 'nfs4', source = '192.0.2.10:/export/music') =>
  `${id} 22 0:${id} / ${point} rw,relatime shared:${id} - ${fstype} ${source} rw,hard`;

/** The installer test's mount table (mountinfo-layout), with its home and work folders made fixed. */
const MOUNTINFO = [
  '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
  mi(60, '/mnt/music'),
  mi(61, '/mnt/backup', 'nfs4', '192.0.2.11:/export/backup'),
  mi(62, '/music'),
  mi(63, '/home/robin/music'),
  mi(64, '/srv/media/music'),
  mi(65, '/data/nas/music'),
  mi(66, '/mnt/music+lossless'),
  mi(67, '/srv/inst/music'),
  mi(68, '/home/music'),
  mi(69, '/media/usb/music'),
  mi(70, '/mnt/my\\040music'),
  '',
].join('\n');

const BASE_FACTS: HostFacts = {
  os: 'linux',
  mountinfo: MOUNTINFO,
  fstab: '',
  propagation: 'shared',
  rootless: false,
  snap: false,
  dockerDesktop: false,
  dockerRoot: '/var/lib/docker',
  parentEntries: ['music'],
  installDir: '/opt/tagave',
};

/** An install's .env as write_env writes it, with `extra` lines after. */
function envOf(opts: { role?: string | null; music?: string | null; mode?: string; extra?: string[] } = {}): string {
  const lines = ['# tagave configuration, written by install-tagave.sh.', 'COMPOSE_PROJECT_NAME=tagave'];
  const role = opts.role === undefined ? 'all' : opts.role;
  if (role !== null) lines.push(`TAGAVE_ROLE=${role}`);
  lines.push('APP_SECRET=abc', "TZ='UTC'");
  const music = opts.music === undefined ? '/mnt/music' : opts.music;
  if (music !== null) lines.push(`MUSIC_DIR='${music}'`, `TAGAVE_MUSIC_MODE=${opts.mode ?? 'rw'}`);
  lines.push(...(opts.extra ?? []));
  return `${lines.join('\n')}\n`;
}

const allKeys = (parent: string, name: string) => ({
  TAGAVE_MUSIC_BIND_SOURCE: parent,
  TAGAVE_MUSIC_BIND_TARGET: '/mnt/.host',
  TAGAVE_PLAYER_BIND_TARGET: '/host',
  TAGAVE_MUSIC_PROPAGATION: 'rslave',
  TAGAVE_MUSIC_NAME: name,
  TAGAVE_PLAYER_MUSIC_FOLDER: `/host/${name}`,
});
const filesKeys = (parent: string, name: string) => ({
  TAGAVE_MUSIC_BIND_SOURCE: parent,
  TAGAVE_MUSIC_BIND_TARGET: '/mnt/.host',
  TAGAVE_MUSIC_PROPAGATION: 'rslave',
  TAGAVE_MUSIC_NAME: name,
});

interface Row {
  /** the installer case it mirrors (test-installer.sh `lay <name>`), or why it has none */
  mirrors: string;
  env?: Parameters<typeof envOf>[0];
  facts?: Partial<HostFacts> | null;
  want: { keys: Record<string, string> } | LayoutRefusal;
}

/**
 * One row per refusal and per parent case. The installer cases that need a
 * terminal (tty-yes, tty-no) or a flag (--music-parent: root2, home, data2,
 * nested, srv with the flag, inst, roparent; --music-direct: forced, both)
 * do not apply to an update; where a flagless twin exists it is here.
 */
const ROWS: Record<string, Row> = {
  'a writable NFS /mnt/music takes the parent': { mirrors: 'lay main', want: { keys: allKeys('/mnt', 'music') } },
  'a read-only install keeps direct before the parent is listed': { mirrors: 'lay ro', env: { mode: 'ro' }, facts: { parentEntries: ['music', 'photos'] }, want: 'read_only' },
  'private propagation': { mirrors: 'lay main with L_PROP=private', facts: { propagation: 'private' }, want: 'private_propagation' },
  'findmnt without an answer': { mirrors: 'lay nofindmnt', facts: { propagation: ' ' }, want: 'private_propagation' },
  'findmnt not read': { mirrors: 'lay nofindmnt (no answer at all)', facts: { propagation: null }, want: 'private_propagation' },
  'shared in a list of propagations': { mirrors: 'none: findmnt can print shared,slave', facts: { propagation: 'shared,slave\n' }, want: { keys: allKeys('/mnt', 'music') } },
  'not Linux': { mirrors: 'lay mac', facts: { os: 'other' }, want: 'not_linux' },
  '/music: the folder above is /': { mirrors: 'lay root', env: { music: '/music' }, want: 'unsafe_parent' },
  '/home/music: the folder above is /home': { mirrors: 'lay home2 without --music-parent', env: { music: '/home/music' }, want: 'unsafe_parent' },
  'a home folder is not under /mnt, /media or /srv': { mirrors: 'lay home without --music-parent', env: { music: '/home/robin/music' }, want: 'unsafe_parent' },
  'the parent inside Docker data': { mirrors: 'lay indroot', env: { music: '/srv/media/music' }, facts: { dockerRoot: '/srv' }, want: 'unsafe_parent' },
  'the parent holds the install folder': { mirrors: 'lay inst without --music-parent', env: { music: '/srv/inst/music' }, facts: { installDir: '/srv/inst/tagave' }, want: 'unsafe_parent' },
  'the parent is the install folder': { mirrors: 'lay inst (the folder itself counts)', facts: { installDir: '/mnt/' }, want: 'unsafe_parent' },
  'an install folder next to the parent is fine': { mirrors: 'none: /mnt2 is not inside /mnt', facts: { installDir: '/mnt2/tagave' }, want: { keys: allKeys('/mnt', 'music') } },
  'the parent holds Docker data': { mirrors: 'lay droot', facts: { dockerRoot: '/mnt/docker' }, want: 'unsafe_parent' },
  'the parent is Docker data': { mirrors: 'lay droot (the folder itself counts)', facts: { dockerRoot: '/mnt/' }, want: 'unsafe_parent' },
  'an odd name': { mirrors: 'lay odd', env: { music: '/mnt/music+lossless' }, want: 'bad_name' },
  '/srv/media/music takes the parent': { mirrors: 'lay srv without --music-parent', env: { music: '/srv/media/music' }, want: { keys: allKeys('/srv/media', 'music') } },
  '/media/usb/music takes the parent': { mirrors: 'lay media', env: { music: '/media/usb/music' }, want: { keys: allKeys('/media/usb', 'music') } },
  '/data/nas/music is not under /mnt, /media or /srv': { mirrors: 'lay data', env: { music: '/data/nas/music' }, want: 'unsafe_parent' },
  'TAGAVE_MUSIC_LAYOUT=direct is kept': { mirrors: 'lay forced (the re-run)', env: { extra: ['TAGAVE_MUSIC_LAYOUT=direct'] }, want: 'owner_direct' },
  'TAGAVE_MUSIC_LAYOUT=direct needs no facts': { mirrors: 'lay forced (it returns before any fact)', env: { extra: ['TAGAVE_MUSIC_LAYOUT=direct'] }, facts: null, want: 'owner_direct' },
  'a plain folder': { mirrors: 'lay plainfolder', env: { music: '/srv/plain/music' }, want: 'not_a_mount' },
  'an fstab entry counts as a mount': { mirrors: 'lay fsonly', env: { music: '/srv/fsonly/music' }, facts: { fstab: '# /etc/fstab\n192.0.2.20:/export/tunes  /srv/fsonly/music/  nfs4  hard,_netdev,nofail,x-systemd.automount  0 0\n' }, want: { keys: allKeys('/srv/fsonly', 'music') } },
  'a commented fstab line does not count': { mirrors: 'none: fstab_entry skips comments', env: { music: '/srv/fsonly/music' }, facts: { fstab: '# 192.0.2.20:/export/tunes /srv/fsonly/music nfs4 hard 0 0\n' }, want: 'not_a_mount' },
  'rootless Docker': { mirrors: 'lay rootless', facts: { rootless: true }, want: 'rootless' },
  'rootless unknown is read as the installer reads an empty answer': { mirrors: 'none: empty security options pass in the installer', facts: { rootless: null }, want: { keys: allKeys('/mnt', 'music') } },
  'snap Docker': { mirrors: 'lay snap', facts: { snap: true }, want: 'snap' },
  'Docker Desktop': { mirrors: 'lay desktop', facts: { dockerDesktop: true }, want: 'docker_desktop' },
  'a files computer writes only the worker keys': { mirrors: 'lay-files (role files)', env: { role: 'files', extra: ['DB_HOST=192.0.2.5'] }, want: { keys: filesKeys('/mnt', 'music') } },
  'an old .env without TAGAVE_ROLE but with DB_HOST is a files computer': { mirrors: 'none: .env from before TAGAVE_ROLE', env: { role: null, extra: ['DB_HOST=192.0.2.5'] }, want: { keys: filesKeys('/mnt', 'music') } },
  'an old .env without TAGAVE_ROLE or DB_HOST is all in one': { mirrors: 'none: .env from before TAGAVE_ROLE', env: { role: null }, want: { keys: allKeys('/mnt', 'music') } },
  'a plain folder next to the music': { mirrors: 'lay plain', facts: { parentEntries: ['music', 'backup', 'photos'] }, want: 'siblings' },
  'a hidden plain folder next to the music': { mirrors: 'lay plain (dotglob)', facts: { parentEntries: ['.cache', 'music'] }, want: 'siblings' },
  'only mount points next to the music': { mirrors: 'lay mounts', facts: { parentEntries: ['music', 'backup'] }, want: { keys: allKeys('/mnt', 'music') } },
  'the parent not listed': { mirrors: "none: the installer's can't list the folder above it", facts: { parentEntries: null }, want: 'no_facts' },
  'Docker data folder not known': { mirrors: "none: the installer's Docker didn't say where it keeps its data", facts: { dockerRoot: null }, want: 'no_facts' },
  'no facts at all': { mirrors: 'none: a failed helper', facts: null, want: 'no_facts' },
  'an app computer has no music to move': { mirrors: 'none: pick_music_layout returns for role app', env: { role: 'app', music: null }, want: 'no_music_dir' },
  'no MUSIC_DIR': { mirrors: 'none', env: { music: null }, want: 'no_music_dir' },
  'a space in the music folder (mountinfo \\040)': { mirrors: 'lay space', env: { music: '/mnt/my music' }, facts: { parentEntries: ['my music'] }, want: { keys: allKeys('/mnt', 'my music') } },
  'a space in the music folder (fstab \\040)': { mirrors: 'lay space', env: { music: '/srv/fs space/music' }, facts: { fstab: '192.0.2.20:/export/tunes  /srv/fs\\040space/music  nfs4  hard  0 0\n' }, want: { keys: allKeys('/srv/fs space', 'music') } },
  'a trailing slash on MUSIC_DIR is trimmed': { mirrors: 'none: pick_music_layout trims it', env: { music: '/mnt/music/' }, want: { keys: allKeys('/mnt', 'music') } },
};

describe('decideLayout', () => {
  for (const [title, row] of Object.entries(ROWS)) {
    it(`${title} (${row.mirrors})`, () => {
      const facts = row.facts === null ? null : { ...BASE_FACTS, ...row.facts };
      const got = decideLayout(envOf(row.env), facts);
      if (typeof row.want === 'string') expect(got).toEqual({ layout: 'direct', why: row.want });
      else expect(got).toEqual({ layout: 'parent', keys: row.want.keys });
    });
  }

  it('every refusal has a row and a plain reason', () => {
    const all: LayoutRefusal[] = ['no_music_dir', 'not_linux', 'not_a_mount', 'read_only', 'bad_name', 'unsafe_parent', 'private_propagation', 'rootless', 'snap', 'docker_desktop', 'siblings', 'owner_direct', 'no_facts'];
    const covered = new Set(Object.values(ROWS).map((r) => r.want).filter((w): w is LayoutRefusal => typeof w === 'string'));
    expect([...covered].sort()).toEqual([...all].sort());
    for (const why of all) {
      const text = layoutReason(why);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain(String.fromCharCode(0x2014));
      expect(text).not.toMatch(/\.$/);
    }
  });

  it('never needs the music folder itself: the reasons name no path of the owner', () => {
    for (const why of ['not_a_mount', 'unsafe_parent', 'siblings'] as const) expect(layoutReason(why)).not.toContain('/mnt/music');
  });
});

describe('cheapRefusal', () => {
  it('says what can be told from .env alone', () => {
    expect(cheapRefusal(envOf({ music: null }))).toBe('no_music_dir');
    expect(cheapRefusal(envOf({ role: 'app' }))).toBe('no_music_dir');
    expect(cheapRefusal(envOf({ extra: ['TAGAVE_MUSIC_LAYOUT=direct'] }))).toBe('owner_direct');
    expect(cheapRefusal(envOf({ mode: 'ro' }))).toBe('read_only');
    expect(cheapRefusal(envOf({ music: '/mnt/music+lossless' }))).toBe('bad_name');
    expect(cheapRefusal(envOf({ music: '/music' }))).toBe('unsafe_parent');
    expect(cheapRefusal(envOf({ music: '/data/nas/music' }))).toBe('unsafe_parent');
    expect(cheapRefusal(envOf({ music: '/srv/inst/music' }), '/srv/inst/tagave')).toBe('unsafe_parent');
    expect(cheapRefusal(envOf())).toBeNull();
    expect(cheapRefusal(envOf(), '/opt/tagave')).toBeNull();
  });

  it('decideLayout without facts gives the cheap refusal first, then no_facts', () => {
    expect(decideLayout(envOf({ mode: 'ro' }), null)).toEqual({ layout: 'direct', why: 'read_only' });
    expect(decideLayout(envOf(), null)).toEqual({ layout: 'direct', why: 'no_facts' });
  });
});

describe('mount table and fstab', () => {
  it('reads mount points with escapes decoded', () => {
    const points = mountPoints(MOUNTINFO);
    expect(points.has('/mnt/music')).toBe(true);
    expect(points.has('/mnt/my music')).toBe(true);
    expect(points.has('/mnt')).toBe(false);
  });
  it('reads fstab targets, trailing slashes trimmed, comments skipped', () => {
    const t = fstabTargets('# c\n  #192.0.2.1:/x /a nfs hard 0 0\n192.0.2.1:/y /b/\\040c/ nfs4 hard 0 0\n/dev/sdb1 / ext4 defaults 0 1\nshort line\n');
    expect([...t].sort()).toEqual(['/', '/b/ c']);
  });
});

describe('parseDockerInfo', () => {
  it('reads the system, the data folder and the security options', () => {
    expect(parseDockerInfo('linux\nUbuntu 24.04.1 LTS\n/var/lib/docker\nname=seccomp,profile=builtin name=cgroupns \n')).toEqual({ os: 'linux', dockerDesktop: false, dockerRoot: '/var/lib/docker', rootless: false, snap: false });
    expect(parseDockerInfo('linux\nUbuntu\n/home/robin/.local/share/docker\nname=seccomp,profile=builtin name=rootless name=cgroupns \n').rootless).toBe(true);
    expect(parseDockerInfo('linux\nDocker Desktop\n/var/lib/docker\nname=seccomp \n').dockerDesktop).toBe(true);
    expect(parseDockerInfo('linux\nUbuntu Core 22\n/var/snap/docker/common/var-lib-docker/\nname=apparmor \n')).toMatchObject({ snap: true, dockerRoot: '/var/snap/docker/common/var-lib-docker' });
    expect(parseDockerInfo('windows\nWindows Server\nC:\\ProgramData\\docker\n\n')).toMatchObject({ os: 'other', rootless: null });
    expect(parseDockerInfo('linux\nUbuntu\n\n\n').dockerRoot).toBeNull();
  });
});

describe('withLayoutKeys', () => {
  it('writes the keys the way write_env does, quoting values with spaces', () => {
    const env = envOf({ music: '/srv/fs space/music' });
    const d = decideLayout(env, { ...BASE_FACTS, fstab: '192.0.2.20:/x /srv/fs\\040space/music nfs4 hard 0 0\n' });
    if (d.layout !== 'parent') throw new Error('expected the parent layout');
    const out = withLayoutKeys(env, d.keys);
    expect(out).toContain("TAGAVE_MUSIC_BIND_SOURCE='/srv/fs space'\n");
    expect(out).toContain('TAGAVE_MUSIC_BIND_TARGET=/mnt/.host\n');
    for (const [k, v] of Object.entries(d.keys)) expect(envGet(out, k)).toBe(v);
    expect(out.startsWith(env)).toBe(true);
  });
  it('replaces a key already there', () => {
    const out = withLayoutKeys('A=1\nTAGAVE_MUSIC_NAME=old\nB=2\n', { TAGAVE_MUSIC_NAME: 'my music' });
    expect(out).toBe("A=1\nTAGAVE_MUSIC_NAME='my music'\nB=2\n");
  });
  it('refuses a value it cannot quote', () => {
    expect(() => withLayoutKeys('', { TAGAVE_MUSIC_NAME: "it's" })).toThrow(/unexpected characters/);
    expect(() => withLayoutKeys('', { TAGAVE_MUSIC_NAME: 'a\nb' })).toThrow(/unexpected characters/);
  });
  it('a parent with a quote in it stays direct, as no line can hold it', () => {
    const env = envOf({ music: "/mnt/robin's/music" });
    expect(decideLayout(env, { ...BASE_FACTS, mountinfo: mi(71, "/mnt/robin's/music") })).toEqual({ layout: 'direct', why: 'unsafe_parent' });
  });
});

// ---------------------------------------------------------------------------
// readHostFacts through a fake Docker.

const IMAGE = `sha256:${'b'.repeat(64)}`;
const INFO = 'linux\nUbuntu 24.04.1 LTS\n/var/lib/docker\nname=seccomp,profile=builtin name=cgroupns \n';

interface Call {
  args: string[];
  opts: RunOptions | undefined;
}

type Answer = Partial<CommandResult> | 'throw';

/** What the host answers each command with; a key is the command after `--` (or `info` for docker info). */
function fakeDocker(over: Partial<Record<'info' | 'mountinfo' | 'fstab' | 'findmnt' | 'list', Answer>> = {}): { docker: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const answers: Record<string, Answer> = {
    info: { stdout: INFO },
    mountinfo: { stdout: MOUNTINFO },
    fstab: { stdout: '' },
    findmnt: { stdout: 'shared\n' },
    list: { stdout: 'music\nbackup\n' },
    ...over,
  };
  const docker: Runner = async (args, opts) => {
    calls.push({ args, opts });
    assertAllowed(args);
    let key: string;
    if (args[0] === 'info') key = 'info';
    else {
      const command = args.slice(args.indexOf('--') + 1);
      if (command.join(' ') === 'cat /proc/self/mountinfo') key = 'mountinfo';
      else if (command.join(' ') === 'cat /etc/fstab') key = 'fstab';
      else if (command[0] === 'findmnt') key = 'findmnt';
      else if (command[0] === 'sh') key = 'list';
      else throw new Error(`unexpected command: ${args.join(' ')}`);
    }
    const a = answers[key]!;
    if (a === 'throw') throw new Error('docker went away');
    return { code: 0, stdout: '', stderr: '', ...a };
  };
  return { docker, calls };
}

describe('readHostFacts', () => {
  it('reads every fact and they decide the parent layout', async () => {
    const { docker, calls } = fakeDocker();
    const env = envOf();
    const facts = await readHostFacts(docker, IMAGE, '/opt/tagave', env);
    expect(facts).toEqual({ ...BASE_FACTS, parentEntries: ['music', 'backup'] });
    expect(decideLayout(env, facts)).toEqual({ layout: 'parent', keys: allKeys('/mnt', 'music') });
    expect(calls).toHaveLength(5);
  });

  it('asks docker info once, through the Runner, not a helper', async () => {
    const { docker, calls } = fakeDocker();
    await readHostFacts(docker, IMAGE, '/opt/tagave', envOf());
    const info = calls.filter((c) => c.args[0] === 'info');
    expect(info).toHaveLength(1);
    expect(info[0]!.args.join(' ')).toMatch(/\{\{\.OSType\}\}.*\{\{\.OperatingSystem\}\}.*\{\{\.DockerRootDir\}\}.*\{\{range \.SecurityOptions\}\}/s);
  });

  it('runs each helper from its own image with a unique name and a 15 s limit', async () => {
    const { docker, calls } = fakeDocker();
    await readHostFacts(docker, IMAGE, '/opt/tagave', envOf());
    const helpers = calls.filter((c) => c.args[0] === 'run');
    expect(helpers).toHaveLength(4);
    const names = helpers.map((c) => c.args[c.args.indexOf('--name') + 1]!);
    expect(new Set(names).size).toBe(4);
    for (const n of names) expect(n).toMatch(new RegExp(`^${LAYOUT_HELPER_PREFIX}-[0-9a-f]{8}$`));
    for (const c of helpers) {
      expect(c.args.slice(0, 4)).toEqual(['run', '--rm', '--privileged', '--pid=host']);
      expect(c.args).toContain(IMAGE);
      expect(c.args.slice(c.args.indexOf(IMAGE) + 1, c.args.indexOf('--'))).toEqual(['-t', '1', '-m']);
    }
    for (const c of calls) expect(c.opts?.timeoutMs).toBe(15_000);
    const findmnt = helpers.find((c) => c.args.includes('findmnt'))!;
    expect(findmnt.args.slice(findmnt.args.indexOf('--') + 1)).toEqual(['findmnt', '-no', 'PROPAGATION', '--target', '/mnt']);
  });

  it('never names MUSIC_DIR in an argv', async () => {
    for (const music of ['/mnt/music', '/mnt/my music', '/srv/media/music']) {
      const { docker, calls } = fakeDocker();
      await readHostFacts(docker, IMAGE, '/opt/tagave', envOf({ music }));
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) for (const a of c.args) expect(a, c.args.join(' ')).not.toContain(music);
    }
  });

  it('lists the parent by names only: a fixed script, the parent passed as its argument', async () => {
    const { docker, calls } = fakeDocker();
    await readHostFacts(docker, IMAGE, '/opt/tagave', envOf());
    const list = calls.find((c) => c.args.includes('sh'))!;
    const command = list.args.slice(list.args.indexOf('--') + 1);
    expect(command[0]).toBe('sh');
    expect(command[1]).toBe('-c');
    expect(command.slice(3)).toEqual(['sh', '/mnt']);
    expect(command[2]).not.toMatch(/\bls\b|\bstat\b|\bfind\b|\btest\b|\[ /);
  });

  it('a missing fstab reads as empty', async () => {
    const { docker } = fakeDocker({ fstab: { code: 1, stderr: 'cat: can\'t open \'/etc/fstab\': No such file or directory' } });
    expect((await readHostFacts(docker, IMAGE, '/opt/tagave', envOf()))?.fstab).toBe('');
  });

  it('keeps the parent entries with spaces, drops empty lines', async () => {
    const { docker } = fakeDocker({ list: { stdout: 'my music\n\n.cache\n' } });
    expect((await readHostFacts(docker, IMAGE, '/opt/tagave', envOf({ music: '/mnt/my music' })))?.parentEntries).toEqual(['my music', '.cache']);
  });

  describe('a failed helper gives null', () => {
    const cases: Array<[string, Parameters<typeof fakeDocker>[0]]> = [
      ['docker info fails', { info: { code: 1, stderr: 'Cannot connect to the Docker daemon' } }],
      ['docker info throws', { info: 'throw' }],
      ['the mount table exits non-zero', { mountinfo: { code: 1 } }],
      ['the mount table times out', { mountinfo: { code: 1, stderr: '\ntimed out after 15 s' } }],
      ['the mount table throws', { mountinfo: 'throw' }],
      ['fstab cannot be read', { fstab: { code: 1, stderr: 'cat: /etc/fstab: Permission denied' } }],
      ['findmnt fails', { findmnt: { code: 127, stderr: 'nsenter: failed to execute findmnt: No such file or directory' } }],
      ['findmnt times out', { findmnt: { code: 143, stderr: '\ntimed out after 15 s' } }],
      ['the listing fails', { list: { code: 1 } }],
      ['the listing times out', { list: { code: 1, stderr: '\ntimed out after 15 s' } }],
    ];
    for (const [title, over] of cases) {
      it(title, async () => {
        const { docker } = fakeDocker(over);
        await expect(readHostFacts(docker, IMAGE, '/opt/tagave', envOf())).resolves.toBeNull();
      });
    }
  });

  it('runs nothing for an install that cannot move', async () => {
    const envs = [
      envOf({ music: null }),
      envOf({ role: 'app', music: null }),
      envOf({ extra: ['TAGAVE_MUSIC_LAYOUT=direct'] }),
      envOf({ mode: 'ro' }),
      envOf({ music: '/mnt/music+lossless' }),
      envOf({ music: '/data/nas/music' }),
    ];
    for (const env of envs) {
      const { docker, calls } = fakeDocker();
      expect(await readHostFacts(docker, IMAGE, '/opt/tagave', env)).toBeNull();
      expect(calls).toEqual([]);
    }
    const { docker, calls } = fakeDocker();
    expect(await readHostFacts(docker, IMAGE, '/srv/inst/tagave', envOf({ music: '/srv/inst/music' }))).toBeNull();
    expect(calls).toEqual([]);
  });

  it('a rootless, snap or Docker Desktop host still decides from the facts', async () => {
    const { docker } = fakeDocker({ info: { stdout: 'linux\nDocker Desktop\n/var/lib/docker\nname=seccomp \n' } });
    const facts = await readHostFacts(docker, IMAGE, '/opt/tagave', envOf());
    expect(decideLayout(envOf(), facts)).toEqual({ layout: 'direct', why: 'docker_desktop' });
  });
});
