/**
 * Follow-rule defaults for a new followed_artists row (XO-345): the library's
 * settings.followRules, or the built-in defaults when the library never set
 * any or the stored value no longer validates. Copied at follow time so a
 * later library change leaves existing follows alone; "Reset to library
 * defaults" on the artist page copies again.
 */
import { normalizeFollowRules, type FollowRules } from '@liner/core';

export function followDefaultsFor(settings: unknown): Pick<FollowRules, 'includePrimary' | 'excludeSecondary'> {
  let obj: unknown = settings;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      obj = null;
    }
  }
  const raw = obj && typeof obj === 'object' ? (obj as Record<string, unknown>)['followRules'] : null;
  let rules: FollowRules;
  try {
    rules = normalizeFollowRules((raw ?? null) as Partial<FollowRules> | null);
  } catch {
    rules = normalizeFollowRules(null); // the defaults, in the same sorted shape
  }
  return { includePrimary: [...rules.includePrimary], excludeSecondary: [...rules.excludeSecondary] };
}
