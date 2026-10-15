/**
 * Roles and what each may do. One table, read by the API's route guard
 * (packages/api/src/permissions) and by the web's useCan(); docs/security.md
 * describes the same thing in words.
 */
import { z } from 'zod';

/** owner: everything · editor: listener + library care · listener: browse and play. */
export const ROLES = ['owner', 'editor', 'listener'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const PERMISSIONS = [
  /** Browse, search, album and artist pages, artwork, and the caller's own ratings, reviews, listens and saved views. */
  'catalog.read',
  /** Play: queue, stream, play events, the caller's own Playback preferences. */
  'player.use',
  /** Library care: scans, tag changes, identify and matching, review queue, gaps, field locks, bulk edits, follows. */
  'library.edit',
  /** Settings for the whole install: music folders, integrations, Playback server, storage, backups, updates, system checks. */
  'system.manage',
  /** People: invites, roles, sign-in resets, removing accounts. */
  'users.manage',
] as const;
export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

const LISTENER: readonly Permission[] = ['catalog.read', 'player.use'];
const EDITOR: readonly Permission[] = [...LISTENER, 'library.edit'];
const OWNER: readonly Permission[] = [...EDITOR, 'system.manage', 'users.manage'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: OWNER,
  editor: EDITOR,
  listener: LISTENER,
};

/** Unknown or missing roles get nothing. */
export function can(role: string | null | undefined, permission: Permission): boolean {
  if (role !== 'owner' && role !== 'editor' && role !== 'listener') return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * What a route needs: no session ('public'), any signed-in person acting on
 * their own account or data ('self'), or a permission.
 */
export type RoutePermission = 'public' | 'self' | Permission;

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  owner: 'Owner',
  editor: 'Editor',
  listener: 'Listener',
};

/** One line per role, for Settings › Users and the invite dialog. */
export const ROLE_DESCRIPTIONS: Readonly<Record<Role, string>> = {
  owner: 'Everything, including settings, updates, backups and people.',
  editor: 'Browse and play, plus library care and tag changes. No system settings.',
  listener: 'Browse, search and play. Their own ratings, reviews and listens.',
};
