import { describe, it, expect } from 'vitest';
import { tagSettingsOf, DEFAULT_TAG_POLICY } from './tagSettings.js';

describe('tagSettingsOf', () => {
  it('defaults: writes off, Q5 policy', () => {
    expect(tagSettingsOf({})).toEqual({ tagWritesEnabled: false, tagPolicy: DEFAULT_TAG_POLICY });
    expect(tagSettingsOf(null)).toEqual({ tagWritesEnabled: false, tagPolicy: DEFAULT_TAG_POLICY });
  });

  it('opens the gate only for an explicit true', () => {
    expect(tagSettingsOf({ tagWritesEnabled: true }).tagWritesEnabled).toBe(true);
    expect(tagSettingsOf({ tagWritesEnabled: 'true' }).tagWritesEnabled).toBe(false);
    expect(tagSettingsOf({ tagWritesEnabled: 1 }).tagWritesEnabled).toBe(false);
  });

  it('returns a stored policy with schema defaults filled in', () => {
    expect(tagSettingsOf({ tagPolicy: { preset: 'fill_blanks_only' } }).tagPolicy)
      .toEqual({ preset: 'fill_blanks_only', id3Version: '2.4', multiValueSeparator: '; ' });
    expect(tagSettingsOf({ tagPolicy: { preset: 'custom', id3Version: '2.3', multiValueSeparator: ' / ', overrides: { genre: 'never' } } }).tagPolicy)
      .toEqual({ preset: 'custom', id3Version: '2.3', multiValueSeparator: ' / ', overrides: { genre: 'never' } });
  });

  it('falls back to the defaults when the stored policy no longer validates', () => {
    expect(tagSettingsOf({ tagPolicy: { preset: 'yolo' } }).tagPolicy).toEqual(DEFAULT_TAG_POLICY);
    expect(tagSettingsOf({ tagPolicy: 'canonical_ids_and_fill' }).tagPolicy).toEqual(DEFAULT_TAG_POLICY);
  });

  it('returns a fresh default object each time', () => {
    const a = tagSettingsOf({}).tagPolicy;
    (a as { preset: string }).preset = 'overwrite_all';
    expect(tagSettingsOf({}).tagPolicy.preset).toBe('canonical_ids_and_fill');
  });
});
