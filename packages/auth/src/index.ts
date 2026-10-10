import { betterAuth } from 'better-auth';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres from 'postgres';
import { deriveAuthSecret as deriveSecret, type AuthEnvConfig } from './config.js';
import { hashPassword, verifyPassword } from './password.js';
import { tagavePlugin } from './tagave-plugin.js';

export * from './config.js';
export { fromNodeHeaders } from 'better-auth/node';
export { APIError } from 'better-auth/api';
export { hashPassword, verifyPassword } from './password.js';

/** Cookie names are `tagave.<name>`, `__Secure-tagave.<name>` when PUBLIC_URL is https. */
export const COOKIE_PREFIX = 'tagave';

/** The legacy 0.6.x session cookie (raw uuid of a `sessions` row). */
export const LEGACY_SESSION_COOKIE = 'sessionId';

export const SESSION_EXPIRES_IN_S = 30 * 24 * 60 * 60;

/** Both spellings of the Better Auth session cookie. */
export function sessionCookieNames(): string[] {
  return [`${COOKIE_PREFIX}.session_token`, `__Secure-${COOKIE_PREFIX}.session_token`];
}

export interface CreateAuthOptions {
  env: AuthEnvConfig;
  /** A postgres.js URL; the auth layer keeps a small pool of its own. */
  databaseUrl: string;
  /** Better Auth's rate limiter (database storage). Default: on in production. */
  rateLimit?: boolean;
  /** Pool size for the auth connections (default 5). */
  maxConnections?: number;
}

/**
 * Open the auth layer's own postgres.js pool. int8 columns (passkey counter,
 * rate-limit timestamps) come back as numbers, which is what Better Auth
 * compares them as.
 */
export function openAuthSql(databaseUrl: string, max = 5): postgres.Sql {
  return postgres(databaseUrl, {
    max,
    onnotice: () => undefined,
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | bigint | string) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  });
}

function buildOptions(opts: CreateAuthOptions, sql: postgres.Sql) {
  const { env } = opts;
  return {
    appName: 'tagave',
    baseURL: env.publicUrl.origin,
    basePath: '/api/auth',
    secret: deriveSecret(env.appSecret),
    trustedOrigins: env.trustedOrigins,
    database: { dialect: new PostgresJSDialect({ postgres: sql }), type: 'postgres' as const },
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
      minPasswordLength: 12,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    user: {
      modelName: 'users',
      fields: {
        name: 'display_name',
        emailVerified: 'email_verified',
        image: 'image',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      additionalFields: {
        role: { type: 'string' as const, required: false, defaultValue: 'owner', input: false, fieldName: 'role' },
      },
    },
    session: {
      modelName: 'auth_sessions',
      fields: {
        expiresAt: 'expires_at',
        token: 'token',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        userId: 'user_id',
      },
      expiresIn: SESSION_EXPIRES_IN_S,
      updateAge: 24 * 60 * 60,
      // Freshness by age is off: step-up (Keyward, L5) replaces it.
      freshAge: 0,
      cookieCache: { enabled: false },
    },
    account: {
      modelName: 'auth_accounts',
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        scope: 'scope',
        password: 'password',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      accountLinking: { enabled: false, disableImplicitLinking: true, trustedProviders: [] as string[] },
    },
    verification: {
      modelName: 'auth_verifications',
      fields: {
        identifier: 'identifier',
        value: 'value',
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    rateLimit: {
      ...(opts.rateLimit === undefined ? {} : { enabled: opts.rateLimit }),
      storage: 'database' as const,
      modelName: 'auth_rate_limits',
      fields: { key: 'key', count: 'count', lastRequest: 'last_request' },
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: env.publicUrl.secure,
      database: { generateId: 'uuid' as const },
      ...(env.trustProxy ? { ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } } : {}),
    },
    databaseHooks: {
      account: {
        // While the bridge release lasts, users.password_hash mirrors the
        // credential hash so rolling back to 0.6.x keeps every password.
        create: { after: async (account: { id: string }) => mirrorPasswordHash(sql, account.id) },
        update: { after: async (account: { id: string }) => mirrorPasswordHash(sql, account.id) },
      },
    },
    plugins: [tagavePlugin()],
  };
}

async function mirrorPasswordHash(sql: postgres.Sql, accountId: string | undefined): Promise<void> {
  if (!accountId) return;
  await sql`
    update users u set password_hash = a.password
      from auth_accounts a
     where a.id = ${accountId} and a.provider_id = 'credential'
       and a.password is not null and a.user_id = u.id
       and u.password_hash is distinct from a.password`;
}

function makeAuth(opts: CreateAuthOptions, sql: postgres.Sql) {
  return betterAuth(buildOptions(opts, sql));
}

export type Auth = ReturnType<typeof makeAuth>;

export interface AuthHandle {
  auth: Auth;
  /** The auth layer's pool (also used for tagave's own auth tables). */
  sql: postgres.Sql;
  close: () => Promise<void>;
}

/** The one Better Auth configuration, shared by the api and liner-doctor. */
export function createAuth(opts: CreateAuthOptions): AuthHandle {
  const sql = openAuthSql(opts.databaseUrl, opts.maxConnections ?? 5);
  const auth = makeAuth(opts, sql);
  return { auth, sql, close: () => sql.end({ timeout: 5 }) };
}

/**
 * Self-heal for rollback-and-return: a user created by 0.6.x (with only
 * users.password_hash) gets its credential account, as 0035 did for
 * everyone. Idempotent; the api runs it on boot.
 */
export async function ensureCredentialAccounts(sql: postgres.Sql): Promise<number> {
  const rows = await sql`
    insert into auth_accounts (user_id, account_id, provider_id, password, created_at, updated_at)
    select u.id, u.id::text, 'credential', u.password_hash, u.created_at, now()
      from users u
     where u.password_hash is not null
       and not exists (select 1 from auth_accounts a where a.user_id = u.id and a.provider_id = 'credential')
    on conflict (provider_id, account_id) do nothing
    returning id`;
  return rows.length;
}
