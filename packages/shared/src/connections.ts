/**
 * Settings › Connections (Music Connections, tagave as a client): the links
 * a person made from this tagave to other music apps, and what the page
 * sends. api › routes/mcConnections.ts answers with these.
 */
import { z } from 'zod';

export type McLinkState = 'active' | 'needs_reapproval' | 'revoked';

/**
 * One capability of a link: `granted` (pulled), `not_granted` (asked for,
 * the person or the remote left it out), or `available` (the remote started
 * offering it after the link was made: re-link to grant; never granted
 * silently).
 */
export interface McCapabilityView {
  capability: string;
  status: 'granted' | 'not_granted' | 'available';
  /** Items the last pull applied and skipped (invalid), when it pulled this one. */
  applied: number | null;
  skipped: number | null;
}

export interface McLinkView {
  id: string;
  /** The remote's origin. */
  remoteUrl: string;
  /** What the remote calls itself (its manifest's `service`). */
  service: string;
  state: McLinkState;
  capabilities: McCapabilityView[];
  /** The last pull that finished. */
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  /** A short, fixed reason (never a token or a remote's answer). */
  lastError: string | null;
  failures: number;
  nextAttemptAt: string | null;
  /** True when pulls have failed for more than a day: the remote looks down. */
  down: boolean;
  createdAt: string;
}

export interface McConnectionsView {
  links: McLinkView[];
  /** This tagave's own address, for the "link back" hint. */
  ownUrl: string | null;
}

export const mcRemoteUrlSchema = z.object({
  url: z.string().trim().min(1, 'Paste the other app’s address').max(2048, 'That address is too long'),
});
export type McRemoteUrl = z.infer<typeof mcRemoteUrlSchema>;

export interface McStartView {
  /** Where to send the browser: the remote's consent page. */
  authorizeUrl: string;
}

/** What `?error=` on Settings › Connections can say after the remote sent the browser back. */
export type McLinkErrorCode = 'access_denied' | 'invalid_state' | 'remote_error' | 'invalid_response';
