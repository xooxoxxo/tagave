/**
 * Better Auth client: sign-in, sign-out, two-factor and passkeys talk to
 * /api/auth/* directly. The signed-in user the app renders still comes from
 * GET /api/v1/auth/me (useMe), which reads the same session cookie.
 */
import { createAuthClient } from 'better-auth/client';
import { twoFactorClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';

type ClientOptions = {
  basePath: string;
  fetchOptions: { credentials: 'include' };
  plugins: [ReturnType<typeof twoFactorClient>, ReturnType<typeof passkeyClient>];
};

export type AuthClient = ReturnType<typeof createAuthClient<ClientOptions>>;

function makeClient(): AuthClient {
  return createAuthClient<ClientOptions>({
    basePath: '/api/auth',
    fetchOptions: { credentials: 'include' },
    plugins: [twoFactorClient(), passkeyClient()],
  });
}

let client: AuthClient | undefined;

/** Created on first use, so importing this module never touches window. */
export function authClient(): AuthClient {
  client ??= makeClient();
  return client;
}

/** The error shape Better Auth's client returns ({ data, error }). */
export interface AuthClientError {
  status?: number | undefined;
  statusText?: string | undefined;
  code?: string | undefined;
  message?: string | undefined;
}
