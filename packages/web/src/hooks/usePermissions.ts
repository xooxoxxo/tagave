/**
 * What the signed-in person may do, for hiding what their role cannot use.
 * The API refuses it either way (permissions/guard.ts); this only keeps the
 * screen honest. The role lives in a small store fed by useMe (useAuth.ts),
 * so components and plain modules (maintenance.ts) read it without a query
 * client.
 */
import { useSyncExternalStore } from 'react';
import { can, type Permission, type Role } from '@tagave/shared';

let current: Role | null = null;
const listeners = new Set<() => void>();

export function setCurrentRole(role: Role | null): void {
  if (role === current) return;
  current = role;
  listeners.forEach((l) => l());
}

export function currentRole(): Role | null {
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The signed-in person's role, or null while signed out or loading. */
export function useRole(): Role | null {
  return useSyncExternalStore(subscribe, currentRole, currentRole);
}

/** Whether the signed-in person's role grants the permission. */
export function useCan(permission: Permission): boolean {
  return can(useRole(), permission);
}
