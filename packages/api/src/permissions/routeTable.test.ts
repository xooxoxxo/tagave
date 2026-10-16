/**
 * Deny by default, checked: build the app exactly as index.ts does
 * (registerApiRoutes), list every route Fastify registers, and fail when an
 * /api route has no permission declared, or when routeTable.ts names a route
 * that no longer exists. Needs no database: nothing is called.
 */
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@tagave/shared';
import { registeredRoutes } from '../testkit/routes.js';
import { declaredPermission, isGuarded, routeKey } from './guard.js';
import { ROUTE_PERMISSIONS } from './routeTable.js';

const VALID = new Set<string>(['public', 'self', ...PERMISSIONS]);

describe('route permissions', () => {
  it('every /api route declares what it needs', async () => {
    const routes = (await registeredRoutes()).filter((r) => isGuarded(r.url));
    expect(routes.length).toBeGreaterThan(150);
    const missing = routes
      .filter((r) => declaredPermission(r.method, r.url, r.config) === undefined)
      .map((r) => routeKey(r.method, r.url));
    // Add each to permissions/routeTable.ts (or `config: { permission }` on the route).
    expect(missing).toEqual([]);
  });

  it('routeTable.ts lists only routes that exist, with known permissions', async () => {
    const keys = new Set((await registeredRoutes()).map((r) => routeKey(r.method, r.url)));
    const stale = Object.keys(ROUTE_PERMISSIONS).filter((k) => !keys.has(k));
    expect(stale).toEqual([]);
    const unknown = Object.entries(ROUTE_PERMISSIONS).filter(([, v]) => !VALID.has(v));
    expect(unknown).toEqual([]);
  });

  it('a route config names a known permission', async () => {
    const bad = (await registeredRoutes())
      .filter((r) => r.config?.permission !== undefined && !VALID.has(r.config.permission))
      .map((r) => routeKey(r.method, r.url));
    expect(bad).toEqual([]);
  });

  it('only the expected routes are public', async () => {
    const pub = (await registeredRoutes())
      .filter((r) => isGuarded(r.url) && declaredPermission(r.method, r.url, r.config) === 'public')
      .map((r) => routeKey(r.method, r.url))
      .filter((k) => !k.includes('/api/v1/docs'))
      .sort();
    expect(pub).toEqual([
      'GET /api/auth/*',
      'GET /api/v1/auth/setup-required',
      'GET /api/v1/connect/authorize',
      'GET /api/v1/health',
      'GET /api/v1/internal/updater/versions',
      'GET /api/v1/invites/:token',
      'GET /api/v1/openapi.json',
      'POST /api/auth/*',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/setup',
      'POST /api/v1/connect/register',
      'POST /api/v1/connect/revoke',
      'POST /api/v1/connect/token',
      'POST /api/v1/invites/:token/accept',
    ]);
  });
});
