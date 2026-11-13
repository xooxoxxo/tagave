/**
 * Sign in with your own login service (OpenID Connect), set up in
 * Settings › Users (0074). The client secret goes to the server and never
 * comes back: the settings say only whether one is set.
 */
import { z } from 'zod';

export const oidcSettingsSchema = z.object({
  /** The button reads "Sign in with <name>". */
  name: z.string().trim().min(1).max(60),
  issuer: z.string().trim().min(1).max(2000),
  clientId: z.string().trim().min(1).max(500),
  /** Left out: keep the stored one. null: none (a public client, PKCE only). */
  clientSecret: z.string().min(1).max(2000).nullable().optional(),
  enabled: z.boolean(),
  /** "Anyone from <name> can join" (as a listener). */
  joinEnabled: z.boolean(),
  /** Only people in this group may join; null or empty: anyone. */
  joinGroup: z.string().trim().max(255).nullable(),
}).strict();
export type OidcSettingsRequest = z.infer<typeof oidcSettingsSchema>;

export const oidcTestSchema = z.object({ issuer: z.string().trim().min(1).max(2000) }).strict();

export interface OidcSettingsView {
  name: string;
  issuer: string;
  clientId: string;
  secretSet: boolean;
  enabled: boolean;
  joinEnabled: boolean;
  joinGroup: string | null;
  updatedAt: string;
}

/** GET /api/v1/users/sign-in-service */
export interface OidcSettingsResponse {
  settings: OidcSettingsView | null;
  /** To copy into the login service's app. */
  redirectUri: string;
  /** The button works (discovery answered with the issuer that was set). */
  active: boolean;
  secretUnreadable: boolean;
}

/** POST /api/v1/users/sign-in-service/test */
export interface OidcTestResult {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  pkceS256: boolean | null;
}

/** GET /api/v1/auth/oidc: what the sign-in and invite pages offer. */
export interface OidcPublicView {
  /** null: no login-service button. */
  name: string | null;
}

/** GET /api/v1/auth/oidc/link: this person's link, for Account. */
export interface OidcLinkView {
  /** The service's name while its button works, else null. */
  name: string | null;
  linked: boolean;
  linkedAt: string | null;
  /** Unlinking leaves a password or passkey to sign in with. */
  canUnlink: boolean;
}

/** A flow start: the browser goes to `url` (the service's sign-in page). */
export interface OidcStartResponse {
  url: string;
}

export const oidcSignInSchema = z.object({
  /** An invite link's token: the account is made from that invite. */
  invite: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/).optional(),
}).strict();
