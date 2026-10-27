/**
 * Each person's own preferences, on the server so they follow the person
 * between devices (0059, user_prefs): the colour theme of Settings ›
 * Appearance.
 *
 *   GET /api/v1/me/prefs   self: { theme } (null until the person picks one)
 *   PUT /api/v1/me/prefs   self: { theme }
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { themeChoiceSchema, userPrefsUpdateSchema, type UserPrefsView } from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { sameSite } from './mcConnections.js';

function user(request: FastifyRequest): { id: string } {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  return request.user;
}

export async function createUserPrefsRoutes(fastify: FastifyInstance) {
  fastify.get('/me/prefs', async (request): Promise<UserPrefsView> => {
    const me = user(request);
    const { sql } = getAuthHandle();
    const [row] = await sql<Array<{ theme: unknown }>>`select theme from user_prefs where user_id = ${me.id}`;
    // a row written in another shape (an older or newer build) reads as no choice
    const theme = themeChoiceSchema.safeParse(row?.theme);
    return { theme: theme.success ? theme.data : null };
  });

  fastify.put('/me/prefs', async (request): Promise<UserPrefsView> => {
    const me = user(request);
    sameSite(request);
    const parsed = userPrefsUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ApiError(400, 'Bad Request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
    }
    const { sql } = getAuthHandle();
    await sql`insert into user_prefs (user_id, theme, updated_at) values (${me.id}, ${sql.json(parsed.data.theme as never)}, now())
              on conflict (user_id) do update set theme = excluded.theme, updated_at = now()`;
    return { theme: parsed.data.theme };
  });
}
