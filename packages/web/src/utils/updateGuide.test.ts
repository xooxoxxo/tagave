import { describe, it, expect } from 'vitest';
import type { ReleaseNote } from '@liner/shared';
import { attentionReleases, guideOrder, rollbackCommand, updateGuide } from './updateGuide';

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

describe('rollbackCommand', () => {
  it('goes back to the running version', () => {
    expect(rollbackCommand('compose', '0.4.1')).toContain('TAGAVE_VERSION=0.4.1');
    expect(rollbackCommand('source', '0.4.1')).toContain('git checkout v0.4.1');
  });
});

describe('attentionReleases', () => {
  it('keeps only releases marked requires attention', () => {
    const r = (version: string, requiresAttention: boolean): ReleaseNote => ({ tag: `v${version}`, version, name: null, body: null, publishedAt: null, url: null, prerelease: false, requiresAttention });
    expect(attentionReleases([r('0.6.0', false), r('0.5.0', true)]).map((x) => x.version)).toEqual(['0.5.0']);
  });
});
