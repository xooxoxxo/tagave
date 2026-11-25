/**
 * The test-only argv allowlist that every fake Docker in the updater tests
 * runs: a forbidden docker command fails the test, whatever the code under
 * test does with the error.
 */
import { describe, expect, it } from 'vitest';
import { assertAllowed, takeViolations } from './argv-guard.testkit.js';

const PROJECT = 'label=com.docker.compose.project=tagave';
const helper = (...command: string[]) => ['run', '--rm', '--privileged', '--pid=host', '--name', 'tagave-music-helper', '--entrypoint', 'nsenter', 'img', '-t', '1', '-m', '--', ...command];

describe('argv allowlist', () => {
  it('argv allowlist: the guard fails on prune, volume rm, down, rm -v and an unlabelled filter', () => {
    const forbidden: string[][] = [
      ['system', 'prune', '-af'],
      ['image', 'prune', '-a'],
      ['volume', 'prune', '-f'],
      ['container', 'prune'],
      ['builder', 'prune'],
      ['system', 'df'],
      ['volume', 'rm', 'tagave_pgdata'],
      ['volume', 'remove', 'tagave_pgdata'],
      ['compose', 'down'],
      ['compose', 'down', '-v'],
      ['compose', '-p', 'tagave', '--profile', 'player', 'down'],
      ['compose', 'run', '-d', '--rm', 'updater', 'sh', '-c', 'sleep 3; docker compose down'],
      ['rm', '-v', 'abc'],
      ['rm', '-fv', 'abc'],
      ['container', 'rm', '--volumes', 'abc'],
      ['compose', 'rm', '--stop', '--force', '-v', 'player'],
      ['compose', 'rm', '-sfv', 'player'],
      ['ps', '-q', '--filter', 'status=running'],
      ['ps', '-q', '--filter=name=app'],
      ['ps', '-aq', '-f', 'label=com.docker.compose.service=app'],
      ['ps', '-q', '--filter', 'label=com.docker.compose.project='],
      ['container', 'ls', '-q', '--filter', 'status=exited'],
      helper('umount', '/mnt/music'),
      helper('umount', '-l', '/mnt/music'),
      helper('/bin/umount', '-f', '/mnt/music'),
      helper('sh', '-c', 'umount -l /mnt/music && mount -a'),
      helper('systemctl', 'stop', 'mnt-music.mount'),
    ];
    for (const argv of forbidden) {
      expect(() => assertAllowed(argv), argv.join(' ')).toThrow(argv.join(' '));
    }
    expect(takeViolations()).toHaveLength(forbidden.length);
  });

  it('passes the argv the updater really sends', () => {
    const allowed: string[][] = [
      ['compose', 'stop', '-t', '30', 'app'],
      ['compose', '-p', 'robin', 'start', 'worker-files'],
      ['compose', 'up', '-d', '--no-deps', 'app'],
      ['compose', 'pull', 'app'],
      ['compose', 'ps', '-a', '-q', 'app'],
      ['compose', 'rm', '--stop', '--force', 'player'],
      ['compose', 'run', '-d', '--rm', '--no-deps', '--label', 'tagave.updater.handover=run-1', '--entrypoint', 'sh', 'updater', '-c', 'sleep 3; docker compose up -d --no-deps updater'],
      ['kill', 'abc123'],
      ['restart', 'abc123', 'def456'],
      ['inspect', '--format', '{{.State.Status}}', 'abc123'],
      ['inspect', '-f', '{{.Image}}', 'abc123'],
      ['image', 'inspect', '--format', '{{json .RepoDigests}}', 'ref'],
      ['image', 'rm', 'ref'],
      ['ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Image}}'],
      ['ps', '-q', '--no-trunc', '--filter', PROJECT],
      ['ps', '-q', '--filter', 'label=tagave.updater.handover'],
      ['ps', '-aq', '--filter', 'label=tagave.updater.handover=run-1'],
      ['volume', 'ls', '-q', '--filter', PROJECT, '--filter', 'label=com.docker.compose.volume=pgdata'],
      helper('systemd-escape', '-p', '--suffix=mount', '/mnt/music'),
      helper('systemctl', 'show', '--property=SourcePath', '--value', 'mnt-music.mount'),
      helper('systemctl', 'start', 'mnt-music.mount'),
      helper('mountpoint', '-q', '/mnt/music'),
      helper('cat', '/proc/self/mountinfo'),
    ];
    for (const argv of allowed) expect(() => assertAllowed(argv), argv.join(' ')).not.toThrow();
    expect(takeViolations()).toEqual([]);
  });

  it('lets volume rm through only when the test asks for it', () => {
    expect(() => assertAllowed(['volume', 'rm', 'tagave_player-data'], { allowVolumeRm: true })).not.toThrow();
    expect(() => assertAllowed(['volume', 'prune', '-f'], { allowVolumeRm: true })).toThrow();
    expect(() => assertAllowed(['compose', 'down', '-v'], { allowVolumeRm: true })).toThrow();
    expect(takeViolations()).toHaveLength(2);
  });

  it('keeps a violation even when the code swallows the error', () => {
    try { assertAllowed(['system', 'prune', '-af']); } catch { /* the code under test may catch it */ }
    expect(takeViolations()).toEqual([['system', 'prune', '-af']]);
  });
});
