/**
 * The music folder self-heal: when to try, the exact helper container, the
 * host commands, and which containers restart, against a fake Docker and a
 * fake app.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HELPER_NAME, MusicHealer, gapAfter, healDecision, helperArgs, hostCommand, musicContainers, musicDirOf, selfHealOn, type HealReport } from './music-heal.js';
import type { MusicProber, MusicReading, ServerAnswer } from './music-probe.js';
import type { CommandResult, Runner } from './runner.js';

const cfg = { minGapMs: 10 * 60_000, maxGapMs: 6 * 60 * 60_000 };
const IMAGE = `sha256:${'a'.repeat(64)}`;

describe('reading .env', () => {
  it('MUSIC_DIR only as a plain absolute path', () => {
    expect(musicDirOf('MUSIC_DIR=/mnt/music\n')).toBe('/mnt/music');
    expect(musicDirOf("MUSIC_DIR='/mnt/music/'\n")).toBe('/mnt/music');
    expect(musicDirOf('MUSIC_DIR=./music\n')).toBeNull();
    expect(musicDirOf('MUSIC_DIR=/\n')).toBeNull();
    expect(musicDirOf('MUSIC_DIR=/mnt/../etc\n')).toBeNull();
    expect(musicDirOf('MUSIC_DIR=/mnt//music\n')).toBeNull();
    expect(musicDirOf('MUSIC_DIR=/mnt/mu\tsic\n')).toBeNull();
    expect(musicDirOf('POSTGRES_PASSWORD=x\n')).toBeNull();
  });

  it('the kill switch: on unless TAGAVE_MUSIC_SELF_HEAL says no', () => {
    expect(selfHealOn('')).toBe(true);
    expect(selfHealOn('TAGAVE_MUSIC_SELF_HEAL=1\n')).toBe(true);
    for (const off of ['0', 'false', 'off', 'no', 'OFF']) expect(selfHealOn(`TAGAVE_MUSIC_SELF_HEAL=${off}\n`)).toBe(false);
  });
});

describe('when to try', () => {
  const base = { on: true, musicDir: '/mnt/music', unmounted: true, busy: false, now: 100 * 60_000, last: null, cfg };
  it('goes when the music looks unmounted and nothing holds it', () => {
    expect(healDecision(base)).toEqual({ go: true });
  });
  it('holds for the switch, a missing MUSIC_DIR, an app that did not answer, a mounted folder and a run', () => {
    expect(healDecision({ ...base, on: false })).toEqual({ go: false, why: 'off' });
    expect(healDecision({ ...base, musicDir: null })).toEqual({ go: false, why: 'no_music_dir' });
    expect(healDecision({ ...base, unmounted: null })).toEqual({ go: false, why: 'unknown' });
    expect(healDecision({ ...base, unmounted: false })).toEqual({ go: false, why: 'not_unmounted' });
    expect(healDecision({ ...base, busy: true })).toEqual({ go: false, why: 'busy' });
  });
  it('at most once per 10 minutes, longer after failures in a row, capped at 6 hours', () => {
    expect(healDecision({ ...base, last: { at: base.now - 9 * 60_000, failures: 0 } })).toEqual({ go: false, why: 'waiting' });
    expect(healDecision({ ...base, last: { at: base.now - 10 * 60_000, failures: 1 } })).toEqual({ go: true });
    expect(healDecision({ ...base, last: { at: base.now - 15 * 60_000, failures: 2 } })).toEqual({ go: false, why: 'waiting' });
    expect(gapAfter(0, cfg)).toBe(10 * 60_000);
    expect(gapAfter(1, cfg)).toBe(10 * 60_000);
    expect(gapAfter(3, cfg)).toBe(40 * 60_000);
    expect(gapAfter(20, cfg)).toBe(6 * 60 * 60_000);
  });
});

describe('the helper', () => {
  it('is its own image, privileged in the host PID namespace, nsenter into PID 1, one fixed command', () => {
    expect(helperArgs(IMAGE, hostCommand.start('mnt-music.mount'))).toEqual([
      'run', '--rm', '--privileged', '--pid=host', '--name', HELPER_NAME, '--entrypoint', 'nsenter', IMAGE,
      '-t', '1', '-m', '-u', '-n', '-i', '--', 'systemctl', 'start', 'mnt-music.mount',
    ]);
  });
  it('a path is one argument, whatever it holds', () => {
    expect(hostCommand.escape('/mnt/my music; rm x')).toEqual(['systemd-escape', '-p', '--suffix=mount', '/mnt/my music; rm x']);
  });
});

/** A Docker that answers from a script, keyed by the command it gets. */
function fakeDocker(answer: (args: string[]) => Partial<CommandResult>): { docker: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const docker: Runner = async (args) => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '', ...answer(args) };
  };
  return { docker, calls };
}

const helperCmd = (args: string[]) => (args[0] === 'run' ? args.slice(args.indexOf('--') + 1) : null);

/** A host where the unit comes from fstab, starts, and the folder fills. */
function hostAnswers(over: Partial<Record<'escape' | 'source' | 'start' | 'mounted' | 'first', Partial<CommandResult>>> = {}) {
  return (args: string[]): Partial<CommandResult> => {
    const cmd = helperCmd(args);
    if (args[0] === 'inspect' && args[2] === '{{.Image}}') return { stdout: `${IMAGE}\n` };
    if (cmd?.[0] === 'systemd-escape') return over.escape ?? { stdout: 'mnt-music.mount\n' };
    if (cmd?.[0] === 'systemctl' && cmd[1] === 'show') return over.source ?? { stdout: '/etc/fstab\n' };
    if (cmd?.[0] === 'systemctl' && cmd[1] === 'start') return over.start ?? {};
    if (cmd?.[0] === 'mountpoint') return over.mounted ?? {};
    if (cmd?.[0] === 'find') return over.first ?? { stdout: '/mnt/music/A\n' };
    if (args[0] === 'ps') return { stdout: 'c-app\nc-files\nc-player\nc-pg\nc-identify\nc-other-app\n' };
    if (args[0] === 'inspect') {
      return {
        stdout: [
          'c-app\tapp\t/srv/tagave/cache\x1f/mnt/music\x1f',
          'c-files\tworker-files\t/mnt/music/\x1f',
          'c-player\tplayer\t/mnt/music\x1f',
          'c-pg\tpostgres\t/mnt/music\x1f',
          'c-identify\tworker-identify\t/srv/tagave/cache\x1f',
          'c-other-app\tapp\t/srv/elsewhere\x1f',
        ].join('\n'),
      };
    }
    return {};
  };
}

async function installWith(env: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'music-heal-'));
  await writeFile(join(dir, '.env'), env);
  return dir;
}

function fakeApp(unmounted: boolean | null) {
  const reports: HealReport[] = [];
  return { app: { unmounted: async () => unmounted, report: async (r: HealReport) => { reports.push(r); } }, reports };
}

describe('an attempt (fake Docker, fake app)', () => {
  it('mounts the unit of MUSIC_DIR, checks it, restarts only the music services of this project', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\nCOMPOSE_PROJECT_NAME=tagave\n');
    const { docker, calls } = fakeDocker(hostAnswers());
    const { app, reports } = fakeApp(true);
    const healer = new MusicHealer({ installDir, docker, app, busy: () => false, self: 'self-id', now: () => 1e9 });
    expect(await healer.tick()).toBe('mounted');
    const helpers = calls.filter((c) => c[0] === 'run');
    for (const h of helpers) expect(h.slice(0, h.indexOf('--') + 1)).toEqual(['run', '--rm', '--privileged', '--pid=host', '--name', HELPER_NAME, '--entrypoint', 'nsenter', IMAGE, '-t', '1', '-m', '-u', '-n', '-i', '--']);
    expect(helpers.map(helperCmd)).toEqual([
      ['systemd-escape', '-p', '--suffix=mount', '/mnt/music'],
      ['systemctl', 'show', '--property=SourcePath', '--value', 'mnt-music.mount'],
      ['systemctl', 'start', 'mnt-music.mount'],
      ['mountpoint', '-q', '/mnt/music'],
      ['find', '/mnt/music', '-mindepth', '1', '-maxdepth', '1', '-print', '-quit'],
    ]);
    expect(calls).toContainEqual(['inspect', '--format', '{{.Image}}', 'self-id']);
    expect(calls).toContainEqual(['ps', '-q', '--no-trunc', '--filter', 'label=com.docker.compose.project=tagave']);
    expect(calls.filter((c) => c[0] === 'restart')).toEqual([['restart', 'c-app', 'c-files', 'c-player']]);
    // never anything else: no unmount, no stop, no other container
    expect(calls.flat().join(' ')).not.toMatch(/umount|\bstop\b|\bkill\b|fstab /);
    expect(reports).toEqual([{ phase: 'start' }, { phase: 'done', ok: true, reason: 'mounted' }]);
  });

  it('without systemd, or MUSIC_DIR not in fstab: nothing is started, the failure is reported', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    for (const [over, reason] of [[{ escape: { code: 127, stdout: '' } }, 'no_systemd'], [{ source: { stdout: '\n' } }, 'not_in_fstab'], [{ source: { stdout: '/run/systemd/generator/x\n' } }, 'not_in_fstab']] as const) {
      const { docker, calls } = fakeDocker(hostAnswers(over));
      const { app, reports } = fakeApp(true);
      expect(await new MusicHealer({ installDir, docker, app, busy: () => false, self: 's' }).tick()).toBe(reason);
      expect(calls.some((c) => helperCmd(c)?.[1] === 'start')).toBe(false);
      expect(calls.some((c) => c[0] === 'restart')).toBe(false);
      expect(reports).toEqual([{ phase: 'done', ok: false, reason }]);
    }
  });

  it('a mount that fails or stays empty restarts nothing', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    for (const [over, reason] of [[{ start: { code: 1 } }, 'mount_failed'], [{ mounted: { code: 1 } }, 'mount_failed'], [{ first: { stdout: '' } }, 'still_empty']] as const) {
      const { docker, calls } = fakeDocker(hostAnswers(over));
      const { app, reports } = fakeApp(true);
      expect(await new MusicHealer({ installDir, docker, app, busy: () => false, self: 's' }).tick()).toBe(reason);
      expect(calls.some((c) => c[0] === 'restart')).toBe(false);
      expect(reports.at(-1)).toEqual({ phase: 'done', ok: false, reason });
    }
  });

  it('waits 10 minutes, then backs off after failures in a row', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    let t = 0;
    const { docker, calls } = fakeDocker(hostAnswers({ start: { code: 1 } }));
    const { app } = fakeApp(true);
    const healer = new MusicHealer({ installDir, docker, app, busy: () => false, self: 's', now: () => t });
    const starts = () => calls.filter((c) => helperCmd(c)?.[1] === 'start').length;
    expect(await healer.tick()).toBe('mount_failed');
    t += 5 * 60_000;
    expect(await healer.tick()).toBeNull();
    t += 5 * 60_000;
    expect(await healer.tick()).toBe('mount_failed');
    t += 10 * 60_000;
    expect(await healer.tick()).toBeNull(); // 20 minutes after two failures
    t += 10 * 60_000;
    expect(await healer.tick()).toBe('mount_failed');
    expect(starts()).toBe(3);
  });

  it('does nothing with the switch off, without MUSIC_DIR, or while the music is there', async () => {
    for (const [env, unmounted] of [['MUSIC_DIR=/mnt/music\nTAGAVE_MUSIC_SELF_HEAL=0\n', true], ['', true], ['MUSIC_DIR=/mnt/music\n', false]] as const) {
      const installDir = await installWith(env);
      const { docker, calls } = fakeDocker(hostAnswers());
      const { app, reports } = fakeApp(unmounted);
      expect(await new MusicHealer({ installDir, docker, app, busy: () => false, self: 's' }).tick()).toBeNull();
      expect(calls).toEqual([]);
      expect(reports).toEqual([]);
    }
  });
});

/** A network share on MUSIC_DIR, read as answering, silent or unknown. */
function networkReading(answer: ServerAnswer | null, mountPoint = '/mnt/music'): MusicReading {
  return {
    dir: '/mnt/music',
    mount: { kind: 'network', fstype: 'nfs4', server: '192.0.2.10', export: '/export/music', hard: true, mountPoint },
    answer,
    verdict: 'ok',
    server: '192.0.2.10',
  };
}

function fakeProber(reading: () => MusicReading | null): { music: MusicProber; reads: Array<Parameters<MusicProber['read']>[0]> } {
  const reads: Array<Parameters<MusicProber['read']>[0]> = [];
  return { music: { read: async (input) => { reads.push(input); return reading(); } }, reads };
}

describe('the music share comes first (fake prober)', () => {
  it('with the server silent, runs no helper that touches the folder, and does not back off', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const { docker, calls } = fakeDocker(hostAnswers());
    const { app, reports } = fakeApp(true);
    const { music, reads } = fakeProber(() => networkReading('silent'));
    let now = 1e9;
    const healer = new MusicHealer({ installDir, docker, app, music, busy: () => false, self: 's', now: () => now });
    expect(await healer.tick()).toBe('server_silent');
    expect(reads).toEqual([{ parts: [], appUnmounted: true }]);
    expect(calls.map(helperCmd).filter(Boolean)).toEqual([]);
    expect(calls.some((c) => c[0] === 'restart')).toBe(false);
    expect(reports).toEqual([{ phase: 'done', ok: false, reason: 'server_silent' }]);
    // 10 min later still silent: tried again (no growth), not reported again
    now += 10 * 60_000;
    expect(await healer.tick()).toBe('server_silent');
    expect(reports).toHaveLength(1);
    now += 10 * 60_000;
    expect(await healer.tick()).toBe('server_silent');
    expect(reads).toHaveLength(3);
  });

  it('with the share in an unknown state, no helper runs and the reason is server_silent', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    for (const answer of ['unknown', null] as const) {
      const { docker, calls } = fakeDocker(hostAnswers());
      const { app, reports } = fakeApp(true);
      const { music } = fakeProber(() => networkReading(answer));
      expect(await new MusicHealer({ installDir, docker, app, music, busy: () => false, self: 's' }).tick()).toBe('server_silent');
      // not one helper run, not even the image lookup
      expect(calls.filter((c) => c[0] === 'run')).toEqual([]);
      expect(calls).toEqual([]);
      expect(reports).toEqual([{ phase: 'done', ok: false, reason: 'server_silent' }]);
    }
  });

  it('reports server_silent once until the reason changes', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const { docker } = fakeDocker(hostAnswers({ start: { code: 1 } }));
    const { app, reports } = fakeApp(true);
    let reading: MusicReading | null = networkReading('silent');
    const { music } = fakeProber(() => reading);
    let now = 1e9;
    const healer = new MusicHealer({ installDir, docker, app, music, busy: () => false, self: 's', now: () => now });
    expect(await healer.tick()).toBe('server_silent');
    now += 10 * 60_000;
    expect(await healer.tick()).toBe('server_silent');
    now += 10 * 60_000;
    reading = null;
    expect(await healer.tick()).toBe('mount_failed');
    now += 10 * 60_000;
    reading = networkReading('silent');
    expect(await healer.tick()).toBe('server_silent');
    expect(reports.filter((r) => r.phase === 'done')).toEqual([
      { phase: 'done', ok: false, reason: 'server_silent' },
      { phase: 'done', ok: false, reason: 'mount_failed' },
      { phase: 'done', ok: false, reason: 'server_silent' },
    ]);
  });

  it('a present network mount that answers goes straight to the restart', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\nCOMPOSE_PROJECT_NAME=tagave\n');
    const { docker, calls } = fakeDocker(hostAnswers());
    const { app, reports } = fakeApp(true);
    const { music } = fakeProber(() => networkReading('answers'));
    const healer = new MusicHealer({ installDir, docker, app, music, busy: () => false, self: 's' });
    expect(await healer.tick()).toBe('mounted');
    expect(calls.map(helperCmd).filter(Boolean)).toEqual([]);
    expect(calls.filter((c) => c[0] === 'restart')).toEqual([['restart', 'c-app', 'c-files', 'c-player']]);
    expect(reports).toEqual([{ phase: 'start' }, { phase: 'done', ok: true, reason: 'mounted' }]);
  });

  it('an answering share mounted above MUSIC_DIR, not on it, takes the usual steps', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const { docker, calls } = fakeDocker(hostAnswers());
    const { app } = fakeApp(true);
    const { music } = fakeProber(() => networkReading('answers', '/mnt'));
    expect(await new MusicHealer({ installDir, docker, app, music, busy: () => false, self: 's' }).tick()).toBe('mounted');
    expect(calls.map(helperCmd).filter(Boolean).map((c) => c![0])).toEqual(['systemd-escape', 'systemctl', 'systemctl', 'mountpoint', 'find']);
  });

  it('a prober that throws takes the usual steps', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const { docker, calls } = fakeDocker(hostAnswers());
    const { app } = fakeApp(true);
    const music: MusicProber = { read: async () => { throw new Error('no host'); } };
    expect(await new MusicHealer({ installDir, docker, app, music, busy: () => false, self: 's' }).tick()).toBe('mounted');
    expect(calls.map(helperCmd).filter(Boolean)).toHaveLength(5);
  });

  it('remount waits for a running tick, never runs beside it', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let blocked = true;
    const answer = hostAnswers();
    const calls: string[][] = [];
    const docker: Runner = async (args) => {
      calls.push(args);
      if (blocked && args[0] === 'inspect' && args[2] === '{{.Image}}') { blocked = false; await held; }
      return { code: 0, stdout: '', stderr: '', ...answer(args) };
    };
    const { app } = fakeApp(true);
    const { music, reads } = fakeProber(() => null);
    const healer = new MusicHealer({ installDir, docker, app, music, busy: () => false, self: 's' });
    const tick = healer.tick();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    let remounted = false;
    const remount = healer.remount('/mnt/music', 'tagave').then((r) => { remounted = true; return r; });
    // a tick while the lock is held skips
    expect(await healer.tick()).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(remounted).toBe(false);
    expect(reads).toHaveLength(1);
    expect(calls).toHaveLength(1);
    release();
    expect(await tick).toBe('mounted');
    expect(await remount).toBe('mounted');
    expect(reads).toHaveLength(2);
    // the remount's calls all come after the tick's restart
    const restarts = calls.map((c, i) => (c[0] === 'restart' ? i : -1)).filter((i) => i >= 0);
    expect(restarts).toHaveLength(2);
    const secondImage = calls.findIndex((c, i) => i > 0 && c[0] === 'inspect' && c[2] === '{{.Image}}');
    expect(secondImage).toBeGreaterThan(restarts[0]!);
  });

  it('two remounts run one after the other', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    let active = 0;
    let most = 0;
    const answer = hostAnswers();
    const docker: Runner = async (args) => {
      if (args[0] === 'inspect' && args[2] === '{{.Image}}') { active++; most = Math.max(most, active); }
      await new Promise((r) => setTimeout(r, 1));
      if (args[0] === 'restart') active--;
      return { code: 0, stdout: '', stderr: '', ...answer(args) };
    };
    const { app } = fakeApp(true);
    let now = 1e9;
    const healer = new MusicHealer({ installDir, docker, app, music: null, busy: () => false, self: 's', now: () => now });
    expect(await Promise.all([healer.remount('/mnt/music', 'tagave'), healer.remount('/mnt/music', 'tagave')])).toEqual(['mounted', 'mounted']);
    expect(most).toBe(1);
    // and the lock is free again
    now += 10 * 60_000;
    expect(await healer.tick()).toBe('mounted');
  });
});

describe('remount obeys the switch and a run that moves containers', () => {
  it('remount says off when the self-heal is switched off, and runs nothing', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\nTAGAVE_MUSIC_SELF_HEAL=off\n');
    const { docker, calls } = fakeDocker(hostAnswers());
    const { app, reports } = fakeApp(true);
    const { music, reads } = fakeProber(() => null);
    const log = vi.fn();
    const healer = new MusicHealer({ installDir, docker, app, music, busy: () => false, updating: () => false, self: 's', log });
    expect(await healer.remount('/mnt/music', 'tagave')).toBe('off');
    expect(calls).toEqual([]);
    expect(reads).toEqual([]);
    expect(reports).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('remount says busy while an update moves containers, and runs nothing', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    const { docker, calls } = fakeDocker(hostAnswers());
    const { app, reports } = fakeApp(true);
    const { music, reads } = fakeProber(() => null);
    const log = vi.fn();
    let updating = true;
    // the tick's busy is not the remount's: a repair that calls remount counts as busy for the tick only
    const healer = new MusicHealer({ installDir, docker, app, music, busy: () => true, updating: () => updating, self: 's', log });
    expect(await healer.remount('/mnt/music', 'tagave')).toBe('busy');
    expect(calls).toEqual([]);
    expect(reads).toEqual([]);
    expect(reports).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    updating = false;
    expect(await healer.remount('/mnt/music', 'tagave')).toBe('mounted');
  });

  it('off and busy are neither recorded nor reported', async () => {
    const installDir = await installWith('MUSIC_DIR=/mnt/music\n');
    let t = 0;
    let updating = false;
    const { docker, calls } = fakeDocker(hostAnswers({ start: { code: 1 } }));
    const { app, reports } = fakeApp(true);
    const log = vi.fn();
    const healer = new MusicHealer({ installDir, docker, app, music: null, busy: () => false, updating: () => updating, self: 's', now: () => t, log });
    const starts = () => calls.filter((c) => helperCmd(c)?.[1] === 'start').length;
    expect(await healer.tick()).toBe('mount_failed');
    t += 10 * 60_000;
    updating = true;
    expect(await healer.remount('/mnt/music', 'tagave')).toBe('busy');
    updating = false;
    await writeFile(join(installDir, '.env'), 'MUSIC_DIR=/mnt/music\nTAGAVE_MUSIC_SELF_HEAL=0\n');
    expect(await healer.remount('/mnt/music', 'tagave')).toBe('off');
    await writeFile(join(installDir, '.env'), 'MUSIC_DIR=/mnt/music\n');
    // still due 10 minutes after one failure: neither pushed the last attempt's time
    expect(await healer.tick()).toBe('mount_failed');
    // two failures in a row, not more: 20 minutes, not 40
    t += 10 * 60_000;
    expect(await healer.tick()).toBeNull();
    t += 10 * 60_000;
    expect(await healer.tick()).toBe('mount_failed');
    expect(starts()).toBe(3);
    expect(reports.filter((r) => r.phase === 'done')).toEqual([
      { phase: 'done', ok: false, reason: 'mount_failed' },
      { phase: 'done', ok: false, reason: 'mount_failed' },
      { phase: 'done', ok: false, reason: 'mount_failed' },
    ]);
    expect(log).toHaveBeenCalledTimes(3);
  });
});

describe('musicContainers', () => {
  it('only this project’s music services that bind MUSIC_DIR', async () => {
    const { docker } = fakeDocker(hostAnswers());
    expect(await musicContainers(docker, 'tagave', '/mnt/music')).toEqual(['c-app', 'c-files', 'c-player']);
    expect(await musicContainers(docker, 'tagave', '/mnt/other')).toEqual([]);
    expect(await musicContainers(fakeDocker(() => ({ code: 1 })).docker, 'tagave', '/mnt/music')).toBeNull();
  });
});
