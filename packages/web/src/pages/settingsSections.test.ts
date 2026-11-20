/**
 * Settings is the server's: what each role finds listed there (spec §3).
 */
import { describe, expect, it } from 'vitest';
import { ROLES } from '@tagave/shared';
import { SERVER_SECTIONS, serverSection, settingsNav } from './settingsSections';

const values = (role: Parameters<typeof settingsNav>[0]) => settingsNav(role).map((s) => s.value);

describe('settingsNav', () => {
  it('a listener has no server section', () => {
    expect(settingsNav('listener')).toEqual([]);
  });

  it('an editor sees Tag writing and Follow rules', () => {
    expect(values('editor')).toEqual(['tag-writing', 'following']);
  });

  it('the owner sees the spec order', () => {
    expect(values('owner')).toEqual(['library', 'tag-writing', 'following', 'people', 'modules', 'backups', 'updates', 'status']);
  });

  it('Genre mapping and Background activity are Library care\'s', () => {
    const all = SERVER_SECTIONS.map((s) => s.value);
    expect(all).not.toContain('genre-mapping');
    expect(all).not.toContain('activity');
  });

  it('no personal section is a server section', () => {
    const personal = ['account', 'appearance', 'security', 'custom-theme', 'connections', 'listening', 'playback', 'listen-elsewhere'];
    const all = SERVER_SECTIONS.map((s) => s.value);
    for (const value of personal) {
      expect(all).not.toContain(value);
      for (const role of ROLES) expect(values(role)).not.toContain(value);
    }
  });

  it('the old names are gone', () => {
    const all = SERVER_SECTIONS.map((s) => s.value);
    for (const value of ['system', 'storage', 'deleting', 'providers', 'users', 'metadata']) expect(all).not.toContain(value);
  });

  it('the setup checklist stays unlisted', () => {
    expect(serverSection('setup-checklist')?.unlisted).toBe(true);
    expect(values('owner')).not.toContain('setup-checklist');
  });

  it('null role', () => {
    expect(settingsNav(null)).toEqual([]);
  });
});
