/**
 * Renders its children only for a role with the permission, else the
 * "Not available for your account" page, or, given `otherwise`, a redirect
 * there in place of the address (an old link that moved behind the
 * permission: routing/redirects.ts). The API refuses the same requests
 * (packages/api/src/permissions); this keeps a direct link from showing a
 * page full of errors.
 *
 *   <RequirePermission permission="library.edit"><PlansPage /></RequirePermission>
 */
import type { ComponentType, ReactNode } from 'react';
import { Navigate } from '@tanstack/react-router';
import type { Permission } from '@tagave/shared';
import { useCan, useRole } from '../../hooks/usePermissions';
import { NotAvailable } from './NotAvailable';

export function RequirePermission({ permission, inline = false, otherwise, children }: { permission: Permission; inline?: boolean; otherwise?: string | undefined; children: ReactNode }) {
  const role = useRole();
  const allowed = useCan(permission);
  // Signed out or still loading: the app shell decides (App.tsx sends to /login).
  if (role === null) return null;
  if (allowed) return <>{children}</>;
  return otherwise ? <Navigate to={otherwise as never} replace /> : <NotAvailable inline={inline} />;
}

/** A route component wrapped in RequirePermission, for router.tsx; `otherwise` as there. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function guarded<C extends ComponentType<any> & { preload?: (() => Promise<void> | undefined) | undefined }>(permission: Permission, Component: C, otherwise?: string): C {
  const Inner = Component as ComponentType<Record<string, unknown>>;
  const Guarded = ((props: Record<string, unknown>) => <RequirePermission permission={permission} otherwise={otherwise}><Inner {...props} /></RequirePermission>) as unknown as C;
  // keep the lazy route's preload-on-hover
  if (Component.preload) Object.assign(Guarded, { preload: Component.preload });
  return Guarded;
}
