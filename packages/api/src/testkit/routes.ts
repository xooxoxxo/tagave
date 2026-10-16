/** Every route the production app registers, for the route-permission tests. */
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { RoutePermission } from '@tagave/shared';
import { registerApiRoutes } from '../app.js';

export interface RegisteredRoute {
  method: string;
  url: string;
  config: { permission?: RoutePermission } | undefined;
}

/** Every route the production app registers (HEAD left out: it is GET's). */
export async function registeredRoutes(): Promise<RegisteredRoute[]> {
  const app = Fastify({ logger: false });
  const routes: RegisteredRoute[] = [];
  app.addHook('onRoute', (r) => {
    for (const method of ([] as string[]).concat(r.method)) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routes.push({ method, url: r.url, config: r.config as RegisteredRoute['config'] });
    }
  });
  await app.register(fastifyCookie);
  await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
  await app.ready();
  await app.close();
  return routes;
}

