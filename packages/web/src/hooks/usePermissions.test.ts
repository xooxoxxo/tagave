import { afterEach, describe, expect, it } from 'vitest';
import { can, ROLE_PERMISSIONS } from '@tagave/shared';
import { currentRole, setCurrentRole } from './usePermissions';
import { readFileSync } from 'node:fs';

describe('roles and what they include', () => {
  afterEach(() => setCurrentRole(null));

  it('a listener browses and plays; an editor adds library care; the owner has everything', () => {
    expect(ROLE_PERMISSIONS.listener).toEqual(['catalog.read', 'player.use']);
    expect(can('editor', 'library.edit')).toBe(true);
    expect(can('editor', 'system.manage')).toBe(false);
    expect(can('owner', 'users.manage')).toBe(true);
    expect(can('listener', 'library.edit')).toBe(false);
    // signed out, or an unknown role: nothing
    expect(can(null, 'catalog.read')).toBe(false);
    expect(can('viewer', 'catalog.read')).toBe(false);
  });

  it('the role store follows the signed-in user', () => {
    expect(currentRole()).toBeNull();
    setCurrentRole('editor');
    expect(currentRole()).toBe('editor');
  });

  it('Maintenance is off for a role without library care', () => {
    const src = readFileSync(new URL('../maintenance.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const allowed = useCan\('library\.edit'\);\s*const on = useSyncExternalStore\(subscribe, snapshot, \(\) => false\) && allowed;/);
  });
});
