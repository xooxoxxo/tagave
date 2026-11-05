/**
 * Each person's own preferences, on the server so they follow the person
 * between devices (0059, user_prefs): the colour theme of Settings ›
 * Appearance, and the DJ module's Simple mode (0087, Settings › Modules ›
 * DJ; the device that plays applies it).
 *
 *   GET /api/v1/me/prefs   self: { theme, dj } (each null until the person picks one)
 *   PUT /api/v1/me/prefs   self: { theme?, dj? } (what is sent is written, the rest kept)
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { djSimpleSettingsSchema, themeChoiceSchema, userPrefsUpdateSchema, type UserPrefsView } from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { sameSite } from './mcConnections.js';

function user(request: FastifyRequest): { id: string } {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  return request.user;
}

type Row = { theme: unknown; dj: unknown };

/** A row written in another shape (an older or newer build) reads as no choice. */
function view(row: Row | undefined): UserPrefsView {
  const theme = themeChoiceSchema.safeParse(row?.theme);
  const dj = djSimpleSettingsSchema.safeParse(row?.dj);
  return { theme: theme.success ? theme.data : null, dj: dj.success ? dj.data : null };
}

export async function createUserPrefsRoutes(fastify: FastifyInstance) {
  fastify.get('/me/prefs', async (request): Promise<UserPrefsView> => {
    const me = user(request);
    const { sql } = getAuthHandle();
    const [row] = await sql<Row[]>`select theme, dj from user_prefs where user_id = ${me.id}`;
    return view(row);
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
    const { theme, dj } = parsed.data;
    const themeJson = theme === undefined ? null : sql.json(theme as never);
    const djJson = dj === undefined ? null : sql.json(dj as never);
    const [row] = await sql<Row[]>`
      insert into user_prefs (user_id, theme, dj, updated_at) values (${me.id}, ${themeJson}, ${djJson}, now())
      on conflict (user_id) do update set
        theme = case when ${theme !== undefined} then excluded.theme else user_prefs.theme end,
        dj = case when ${dj !== undefined} then excluded.dj else user_prefs.dj end,
        updated_at = now()
      returning theme, dj`;
    return view(row);
  });
}
