/**
 * Follow rules (XO-301 GAP-2): which of a followed artist's release groups
 * count. The library sets defaults in settings.followRules (Settings › Follow
 * rules); a followed_artists row overrides them per artist, and a null column
 * inherits the library value.
 */
import { normalizeFollowRules, type FollowRules } from '@liner/core';
import type { WorkerContext } from './context.js';

export interface EffectiveFollowRules {
  includePrimary: string[];
  excludeSecondary: string[];
}

/**
 * libraries.settings → normalised follow rules. A missing or invalid value
 * falls back to the built-in defaults: a stored typo must not stop the gap
 * pass or a refresh.
 */
export function libraryFollowRules(settings: unknown): FollowRules {
  let obj: unknown = settings;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      obj = null;
    }
  }
  const raw = obj && typeof obj === 'object' ? (obj as Record<string, unknown>)['followRules'] : null;
  try {
    return normalizeFollowRules((raw ?? null) as Partial<FollowRules> | null);
  } catch {
    return normalizeFollowRules(null); // the defaults, in the same sorted shape
  }
}

export async function loadLibraryFollowRules(ctx: WorkerContext, libraryId: string): Promise<FollowRules> {
  const rows = await ctx.sql`select settings from libraries where id = ${libraryId}` as unknown as Array<{ settings: unknown }>;
  return libraryFollowRules(rows[0]?.settings ?? null);
}

/** Per-artist columns win; null inherits the library rules. */
export function effectiveFollowRules(
  library: FollowRules,
  row: { includePrimary: string[] | null; excludeSecondary: string[] | null } | null | undefined,
): EffectiveFollowRules {
  return {
    includePrimary: row?.includePrimary ?? [...library.includePrimary],
    excludeSecondary: row?.excludeSecondary ?? [...library.excludeSecondary],
  };
}

/** Same predicate the gap SQL applies: primary type included, no excluded secondary type. */
export function releaseGroupMatchesRules(
  rg: { primaryType: string | null; secondaryTypes: string[] | null },
  rules: EffectiveFollowRules,
): boolean {
  if (!rg.primaryType || !rules.includePrimary.includes(rg.primaryType)) return false;
  return !(rg.secondaryTypes ?? []).some((t) => rules.excludeSecondary.includes(t));
}
