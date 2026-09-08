/**
 * Tag-write settings (M2, spec §12.8): the library master switch and the
 * default write policy new plans start from. Both live in libraries.settings;
 * the policy follows the Q5 defaults of the M2 plan when nothing (or something
 * unparseable) is stored.
 */
import { tagPoliciesSchema, type TagPolicies } from '@liner/shared';

export const DEFAULT_TAG_POLICY: TagPolicies = {
  preset: 'canonical_ids_and_fill',
  id3Version: '2.4',
  multiValueSeparator: '; ',
};

export function tagSettingsOf(settings: unknown): { tagWritesEnabled: boolean; tagPolicy: TagPolicies } {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {};
  const parsed = tagPoliciesSchema.safeParse(s['tagPolicy']);
  return {
    // only an explicit true opens the gate; the worker applies the same test per file
    tagWritesEnabled: s['tagWritesEnabled'] === true,
    tagPolicy: parsed.success ? parsed.data : { ...DEFAULT_TAG_POLICY },
  };
}
