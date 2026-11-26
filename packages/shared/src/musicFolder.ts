/**
 * Music folder reach (0097, vault "tagave - Offline Library Spec" §3): what
 * the folder watch last saw on a root. `unknown` is a root with no reading
 * yet, which reads as "Checking". The reason is a fixed code, never host text.
 */
export const REACH_VALUES = ['unknown', 'online', 'offline', 'unmounted'] as const;
export type Reach = (typeof REACH_VALUES)[number];

export const REACH_REASONS = ['server_silent', 'timeout', 'io_error', 'stale', 'empty', 'not_mounted'] as const;
export type ReachReason = (typeof REACH_REASONS)[number];
