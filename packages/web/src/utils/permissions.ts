/**
 * Who may see and run system things: storage, disk space, backups, updates.
 * Today that is the owner role; one helper so it can become a permission
 * check ('system.manage') in one place.
 */
import type { SessionUser } from '@tagave/shared';

export function canManageSystem(user: Pick<SessionUser, 'role'> | null | undefined): boolean {
  return user?.role === 'owner';
}
