/**
 * Test kit for the auth suites: a scratch database on TEST_DATABASE_URL's
 * server and a Fastify app wired like index.ts (cookie plugin, error
 * handler, bridge + session hooks, Better Auth catch-all, tagave auth
 * routes) plus one protected probe route.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { MIGRATIONS_DIR, listMigrationChain, migrationFilePath, parseMigrationEntry, runMigrations } from '@tagave/db';
import { createAuth, readAuthEnv, type AuthHandle } from '@tagave/auth';
import { errorHandler } from '../middleware/errorHandler.js';
import { authMiddleware, initAuth } from '../middleware/auth.js';
import { createBetterAuthRoutes } from '../routes/betterAuth.js';
import { createAuthRoutes } from '../routes/auth.js';

export const TEST_PUBLIC_URL = 'http://localhost:3100';
export const TEST_APP_SECRET = 'f'.repeat(64);

const quiet = () => undefined;

export async function createScratchDb(adminUrl: string, admin: postgres.Sql): Promise<{ url: string; name: string }> {
  const name = `tagave_auth_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.unsafe(`create database ${name}`);
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return { url: u.toString(), name };
}

/**
 * The migrations, in the order they apply (the core chain, then each app's
 * and module's own), that come before `before`: a core file name or prefix
 * ('0035': the 0.6.1 shape, no app or module chain) or a chain's entry
 * ('decider/0002': the whole core chain, the chains before decider's, and
 * decider's files before 0002).
 */
export async function migrationsBefore(before: string, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const cut = parseMigrationEntry(before);
  const out: string[] = [];
  let inCutChain = false;
  for (const entry of await listMigrationChain(dir)) {
    const { module, name } = parseMigrationEntry(entry);
    if (module === cut.module) {
      inCutChain = true;
      if (name >= cut.name) break;
    } else if (inCutChain || (cut.module === 'core' && module !== 'core')) {
      break;
    }
    out.push(entry);
  }
  return out;
}

/** Migrate a database to the last schema before `before` (e.g. the 0.6.1 shape), module chains included. */
export async function migrateUpTo(url: string, before: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tagave-auth-migs-'));
  try {
    for (const entry of await migrationsBefore(before)) {
      const src = await migrationFilePath(MIGRATIONS_DIR, entry);
      const dest = join(dir, relative(MIGRATIONS_DIR, src));
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
    }
    await runMigrations(url, { migrationsDir: dir, log: quiet });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function migrateAll(url: string): Promise<string[]> {
  return (await runMigrations(url, { log: quiet })).applied;
}

export function testAuth(url: string, appSecret: string = TEST_APP_SECRET): AuthHandle {
  const env = readAuthEnv({ APP_SECRET: appSecret, PUBLIC_URL: TEST_PUBLIC_URL });
  return createAuth({ env, databaseUrl: url, rateLimit: false, maxConnections: 4 });
}

type Extra = (instance: FastifyInstance) => Promise<void>;

/** `protectedRoutes` join the probe behind the sign-in check; `rootRoutes` sit next to the auth routes. */
export async function buildAuthApp(
  handle: AuthHandle,
  protectedRoutes?: Extra,
  rootRoutes?: Extra,
  serverOptions: Pick<FastifyServerOptions, 'trustProxy'> = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ...serverOptions });
  await app.register(fastifyCookie);
  initAuth(handle);
  await errorHandler(app);
  await authMiddleware(app);
  if (rootRoutes) await app.register(rootRoutes);
  await app.register(createBetterAuthRoutes);
  await app.register(createAuthRoutes, { prefix: '/api/v1/auth' });
  await app.register(async (instance) => {
    instance.addHook('preHandler', async (request, reply) => {
      if (!request.user) await reply.status(401).send({ status: 401, title: 'Unauthorized' });
    });
    instance.get('/api/v1/probe', { config: { permission: 'self' } }, async (request) => ({ user: request.user, sessionId: request.sessionId }));
    if (protectedRoutes) await protectedRoutes(instance);
  });
  await app.ready();
  return app;
}

/** `name=value` pairs from a response's Set-Cookie headers (cleared cookies dropped). */
export function cookieJar(setCookie: string | string[] | undefined, jar: Record<string, string> = {}): Record<string, string> {
  const list = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of list) {
    const pair = c.split(';')[0]!;
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const cleared = /max-age=0/i.test(c) || /expires=Thu, 01 Jan 1970/i.test(c) || value === '';
    if (cleared) delete jar[name];
    else jar[name] = value;
  }
  return jar;
}

/** RFC 6238 code (SHA-1, 6 digits, 30 s) for the secret in an otpauth:// URI. */
export function totpFromUri(uri: string, at: number = Date.now()): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error(`no secret in ${uri}`);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error(`bad base32 in ${uri}`);
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac('sha1', bytes).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}
