/**
 * Settings › Users and the links it hands out (0043): an invite makes a new
 * account, a set-password link resets someone's sign-in. Both are one-time,
 * expire after INVITE_TTL_DAYS and are stored as a hash.
 */
import { z } from 'zod';
import { roleSchema } from './permissions.js';

export const INVITE_TTL_DAYS = 7;
/** The same rule as setup and Better Auth (minPasswordLength). */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export const userStatusSchema = z.enum(['active', 'disabled', 'removed']);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const userViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  createdAt: z.string(),
  /** Latest session activity, null when they never signed in. */
  lastSeenAt: z.string().nullable(),
  twoFactor: z.boolean(),
  passkeys: z.number().int(),
  /** The person looking at the list. */
  isSelf: z.boolean(),
});
export type UserView = z.infer<typeof userViewSchema>;

export const invitePurposeSchema = z.enum(['invite', 'reset']);
export type InvitePurpose = z.infer<typeof invitePurposeSchema>;

export const inviteViewSchema = z.object({
  id: z.string().uuid(),
  purpose: invitePurposeSchema,
  email: z.string(),
  role: roleSchema,
  /** The account a set-password link is for. */
  userId: z.string().uuid().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  expired: z.boolean(),
  createdBy: z.string().nullable(),
});
export type InviteView = z.infer<typeof inviteViewSchema>;

export interface UsersOverview {
  users: UserView[];
  /** Links not used, revoked or expired more than a day ago. */
  invites: InviteView[];
}

export const createInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  role: roleSchema,
}).strict();
export type CreateInviteRequest = z.infer<typeof createInviteSchema>;

/** The link is shown once, right after it is made; only its hash is kept. */
export interface InviteLinkResponse {
  invite: InviteView;
  link: string;
}

export const patchUserSchema = z.object({
  role: roleSchema.optional(),
  disabled: z.boolean().optional(),
}).strict().refine((v) => v.role !== undefined || v.disabled !== undefined, { message: 'Nothing to change' });
export type PatchUserRequest = z.infer<typeof patchUserSchema>;

export const removeUserSchema = z.object({
  /** keep: close the account, keep their ratings, reviews and listens. delete: delete those too. */
  data: z.enum(['keep', 'delete']),
}).strict();
export type RemoveUserRequest = z.infer<typeof removeUserSchema>;

export const resetSignInSchema = z.object({
  /** Also turn off their authenticator app and remove their passkeys when they use the link. */
  clearSecondFactors: z.boolean().default(false),
}).strict();
export type ResetSignInRequest = z.infer<typeof resetSignInSchema>;

/** What the invite page shows before anyone has an account. */
export interface InviteLookup {
  purpose: InvitePurpose;
  email: string;
  role: z.infer<typeof roleSchema>;
  /** A set-password link: the account's current name. */
  name: string | null;
  expiresAt: string;
  clearSecondFactors: boolean;
}

export const acceptInviteSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
}).strict();
export type AcceptInviteRequest = z.infer<typeof acceptInviteSchema>;
