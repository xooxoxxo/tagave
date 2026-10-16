/**
 * Who may do what with the player, in one place. The permission layer
 * (packages/api/src/permissions) checks the same names centrally from each
 * route's `config.permission`; this inline check is a second line inside the
 * handlers and reads the same table (@tagave/shared › permissions):
 *
 *   player.use     every signed-in person (owner, editor, listener)
 *   system.manage  the owner only (the server and the Last.fm application)
 */
import type { FastifyContextConfig, FastifyRequest } from 'fastify';
import { can } from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';

export type PlayerPermission = 'player.use' | 'system.manage';

export interface PlayerCaller {
  id: string;
  email: string;
  role: string;
}

export function hasPlayerPermission(role: string | null | undefined, permission: PlayerPermission): boolean {
  return can(role, permission);
}

/** The signed-in caller when they hold `permission`; 401 / 403 otherwise. */
export function requirePlayer(request: FastifyRequest, permission: PlayerPermission = 'player.use'): PlayerCaller {
  const user = request.user as PlayerCaller | undefined;
  if (!user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  if (!hasPlayerPermission(user.role, permission)) {
    throw new ApiError(403, 'Forbidden', permission === 'system.manage' ? 'Only the owner can change playback settings' : 'Not available for your account');
  }
  return user;
}

/**
 * The route option the central permission layer reads (cast: the layer
 * declares the `permission` key on FastifyContextConfig itself).
 */
export const permission = (p: PlayerPermission | 'self') => ({ config: { permission: p } as unknown as FastifyContextConfig });
