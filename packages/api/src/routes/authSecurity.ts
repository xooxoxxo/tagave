import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  COOKIE_PREFIX,
  listTrustedDevices,
  revokeTrustedDevice,
  trustIdentifierFromCookie,
} from '@liner/auth';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';

const TRUST_COOKIES = [`${COOKIE_PREFIX}.trust_device`, `__Secure-${COOKIE_PREFIX}.trust_device`];

function currentTrustIdentifier(request: FastifyRequest): string | undefined {
  for (const name of TRUST_COOKIES) {
    const id = trustIdentifierFromCookie(request.cookies[name]);
    if (id) return id;
  }
  return undefined;
}

function requireUser(request: FastifyRequest) {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  return request.user;
}

/**
 * Settings › Security: what protects the signed-in account (password,
 * authenticator app, backup codes, passkeys, trusted devices). Changes go
 * through Better Auth's own endpoints from the browser; this route only reads,
 * plus revoking a trusted device, which Better Auth has no endpoint for.
 */
export async function createAuthSecurityRoutes(fastify: FastifyInstance) {
  fastify.get('/security', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request);
    const { auth, sql } = getAuthHandle();

    const [account] = await sql<Array<{ updated_at: Date }>>`
      select updated_at from auth_accounts
       where user_id = ${user.id} and provider_id = 'credential' and password is not null`;
    const [tf] = await sql<Array<{ two_factor_enabled: boolean; verified: boolean | null }>>`
      select u.two_factor_enabled, t.verified
        from users u left join auth_two_factors t on t.user_id = u.id
       where u.id = ${user.id}`;
    const twoFactorEnabled = Boolean(tf?.two_factor_enabled && tf.verified !== false);

    let backupCodesLeft: number | null = null;
    if (twoFactorEnabled) {
      try {
        const res = await auth.api.viewBackupCodes({ body: { userId: user.id } });
        backupCodesLeft = res.backupCodes.length;
      } catch (err) {
        request.log.warn({ err }, 'security: backup codes could not be read');
      }
    }

    const passkeys = await sql<Array<{
      id: string; name: string | null; aaguid: string | null; device_type: string;
      backed_up: boolean; transports: string | null; created_at: Date | null;
    }>>`
      select id, name, aaguid, device_type, backed_up, transports, created_at
        from auth_passkeys where user_id = ${user.id} order by created_at`;

    const current = currentTrustIdentifier(request);
    const devices = await listTrustedDevices(sql, user.id);

    return reply.send({
      password: { set: Boolean(account), changedAt: account?.updated_at.toISOString() ?? null },
      twoFactor: { enabled: twoFactorEnabled, backupCodesLeft },
      passkeys: passkeys.map((p) => ({
        id: p.id,
        name: p.name,
        aaguid: p.aaguid,
        deviceType: p.device_type,
        backedUp: p.backed_up,
        transports: p.transports ? p.transports.split(',') : [],
        createdAt: p.created_at?.toISOString() ?? null,
      })),
      trustedDevices: devices.map((d) => ({
        id: d.id,
        userAgent: d.userAgent,
        ipAddress: d.ipAddress,
        createdAt: d.createdAt.toISOString(),
        lastUsedAt: d.lastUsedAt.toISOString(),
        expiresAt: d.expiresAt.toISOString(),
        current: d.identifier === current,
      })),
    });
  });

  fastify.delete('/trusted-devices/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const user = requireUser(request);
    const { id } = request.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, 'Not Found', 'No such trusted device');
    const { sql } = getAuthHandle();
    const devices = await listTrustedDevices(sql, user.id);
    const device = devices.find((d) => d.id === id);
    if (!device || !(await revokeTrustedDevice(sql, user.id, id))) {
      throw new ApiError(404, 'Not Found', 'No such trusted device');
    }
    if (device.identifier === currentTrustIdentifier(request)) {
      for (const name of TRUST_COOKIES) reply.clearCookie(name, { path: '/' });
    }
    return reply.status(204).send();
  });
}
