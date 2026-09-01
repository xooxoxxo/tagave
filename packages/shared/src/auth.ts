import { z } from 'zod';

/**
 * User roles per PLT-1 and Section 16
 */
export const userRoleSchema = z.enum(['owner', 'viewer']).describe('User role: owner can write, viewer is read-only');

export type UserRole = z.infer<typeof userRoleSchema>;

/**
 * Setup request for first-run account creation
 * Per PLT-4, the contact string is required during onboarding
 */
export const setupRequestSchema = z.object({
  email: z.string().email().describe('Owner email address'),
  password: z.string().min(8).describe('Account password'),
  displayName: z.string().min(1).describe('Display name for the owner'),
  contactString: z.string().url().or(z.string().email()).describe('Contact URL or email for provider User-Agent headers (required by spec Section 10.2.3)'),
}).strict();

export type SetupRequest = z.infer<typeof setupRequestSchema>;

/**
 * Login request
 */
export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string(),
}).strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Authenticated session user
 * Returned by GET /me and persisted in server-side sessions
 */
export const sessionUserSchema = z.object({
  id: z.string().uuid().describe('User ID (UUIDv7)'),
  email: z.string().email(),
  displayName: z.string(),
  role: userRoleSchema,
  createdAt: z.string().datetime().describe('ISO 8601 timestamp'),
}).strict();

export type SessionUser = z.infer<typeof sessionUserSchema>;
