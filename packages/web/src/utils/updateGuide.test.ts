import { describe, it, expect } from 'vitest';
import type { InstallMethod, ReleaseNote } from '@liner/shared';
import { attentionReleases, backupLocation, guideOrder, rollbackGuide, updateGuide } from './updateGuide';

const commands = (g: ReturnType<typeof updateGuide>) => g.steps.map((s) => s.command ?? '').join('\n');

describe('guideOrder', () => {
  it('puts the detected install first', () => {
    expect(guideOrder('compose')).toEqual(['compose', 'installer', 'source']);
    expect(guideOrder('source')).toEqual(['source', 'installer', 'compose']);
    expect(guideOrder('portainer')).toEqual(['portainer', 'installer', 'compose', 'source']);
  });

  it('leads with the installer when the install is unknown', () => {
    expect(guideOrder('unknown')).toEqual(['installer', 'compose', 'source']);
  });
});

describe('updateGuide', () => {
  it('gives the installer its update command first, with the version filled in', () => {
    const g = updateGuide('installer', { role: 'all' }, '0.5.0');
    expect(g.steps[0]!.command).toContain('install-tagave.sh)" _ update --version 0.5.0');
    expect(g.intro).not.toMatch(/split install/);
  });

  it('reminds a split install to update the music computer too', () => {
    expect(updateGuide('installer', { role: 'app' }, '0.5.0').intro).toMatch(/split install/);
  });

  it('backs up, pins, pulls and restarts a compose install', () => {
    const c = commands(updateGuide('compose', { role: null }, '0.5.0'));
    const order = ['pg_dump', 'TAGAVE_VERSION=0.5.0', 'docker compose pull', 'docker compose up -d'].map((s) => c.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('checks out the release tag for a source install', () => {
    expect(commands(updateGuide('source', { role: null }, '0.5.0'))).toContain('git checkout v0.5.0');
  });

  it('names the version on the platform guides and backs up inside the app container', () => {
    for (const m of ['portainer', 'dokploy', 'coolify', 'unraid'] as const) {
      const g = updateGuide(m, { role: null }, '0.5.0');
      expect(g.steps.map((s) => s.text).join(' ')).toContain('0.5.0');
      expect(commands(g)).toContain('cli.js backup');
    }
  });

  it('shows a placeholder when no version is known', () => {
    expect(commands(updateGuide('compose', { role: null }, null))).toContain('TAGAVE_VERSION=<version>');
  });
});

describe('rollbackGuide', () => {
  const all: InstallMethod[] = ['installer', 'compose', 'source', 'portainer', 'dokploy', 'coolify', 'unraid', 'unknown'];
  const text = (g: { intro: string; steps: Array<{ text: string; command?: string }> }) =>
    [g.intro, ...g.steps.flatMap((s) => [s.text, s.command ?? ''])].join('\n');

  it('restores from the same place the update guide backed up to, for every method', () => {
    for (const m of all) {
      const where = backupLocation(m, '0.5.0');
      expect(text(updateGuide(m, { role: null }, '0.5.0')), m).toContain(where);
      expect(text(rollbackGuide(m, { role: null }, '0.4.1', '0.5.0')), m).toContain(where);
    }
  });

  it('uses the backup inside the container on the platforms, not a .env on the host', () => {
    for (const m of ['portainer', 'dokploy', 'coolify', 'unraid'] as const) {
      const t = text(rollbackGuide(m, { role: null }, '0.4.1', '0.5.0'));
      expect(t).toContain('/cache/backups/');
      expect(t).toContain('$DATABASE_URL');
      expect(t).not.toContain('.env');
      expect(t).not.toContain('docker compose');
      expect(t).toContain('0.4.1');
    }
  });

  it('uses the installer backup folder on an installer install', () => {
    const t = text(rollbackGuide('installer', { role: null }, '0.4.1', '0.5.0'));
    expect(t).toContain('backups/pre-update-');
    expect(t).toContain('$B/database.pgdump');
  });

  it('restores before it pins or starts the older version, and stops at the first failure', () => {
    const cmd = rollbackGuide('compose', { role: null }, '0.4.1', '0.5.0').steps[0]!.command!;
    const lines = cmd.split('\n');
    // every line but the last continues with &&, so a failed restore stops the rest
    expect(lines.slice(0, -1).every((l) => l.endsWith(' &&'))).toBe(true);
    const at = (s: string) => cmd.indexOf(s);
    expect(at('test -s tagave-before-0.5.0.pgdump')).toBe(0);
    expect(at('pg_restore')).toBeGreaterThan(0);
    expect(at('TAGAVE_VERSION=0.4.1')).toBeGreaterThan(at('pg_restore'));
    expect(lines.at(-1)).toBe('docker compose up -d');
  });

  it('checks out the older tag only after the restore on a source install', () => {
    const cmd = rollbackGuide('source', { role: null }, '0.4.1', '0.5.0').steps[0]!.command!;
    expect(cmd.indexOf('git checkout v0.4.1')).toBeGreaterThan(cmd.indexOf('pg_restore'));
    expect(cmd.startsWith('test -s tagave-before-0.5.0.pgdump &&')).toBe(true);
  });
});

describe('update commands stop at the first failure', () => {
  it('chains the compose backup to the rest, so a failed backup does not update', () => {
    const cmd = updateGuide('compose', { role: null }, '0.5.0').steps[0]!.command!;
    const lines = cmd.split('\n');
    expect(lines[0]).toMatch(/pg_dump .* > tagave-before-0\.5\.0\.pgdump &&$/);
    expect(lines.slice(0, -1).every((l) => l.endsWith(' &&'))).toBe(true);
  });

  it('does not assume the installer lives in ~/tagave', () => {
    const g = updateGuide('installer', { role: null }, '0.5.0');
    expect(g.steps[0]!.command).not.toContain('cd ~/tagave');
    expect(g.steps.map((s) => s.text).join(' ')).toContain('--dir');
  });
});

describe('attentionReleases', () => {
  it('keeps only releases marked requires attention', () => {
    const r = (version: string, requiresAttention: boolean): ReleaseNote => ({ tag: `v${version}`, version, name: null, body: null, publishedAt: null, url: null, prerelease: false, requiresAttention });
    expect(attentionReleases([r('0.6.0', false), r('0.5.0', true)]).map((x) => x.version)).toEqual(['0.5.0']);
  });
});
