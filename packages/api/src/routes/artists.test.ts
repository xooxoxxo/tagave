/**
 * Tests for artist routes including per-artist follow rules
 */
import { describe, it, expect } from 'vitest';
import { normalizeFollowRules } from '@liner/core';
import type { FollowRules } from '@liner/shared/library';

describe('Artist routes - follow rules', () => {
  it('should normalize follow rules with defaults', () => {
    const rules = normalizeFollowRules({
      includePrimary: ['Album'],
      excludeSecondary: ['Compilation'],
    });

    expect(rules.includePrimary).toContain('Album');
    expect(rules.excludeSecondary).toContain('Compilation');
    expect(rules.autoFollowMinAlbums).toBe(2);
  });

  it('should validate primary types', () => {
    expect(() => {
      normalizeFollowRules({
        includePrimary: ['Album', 'InvalidType' as any],
      });
    }).toThrow();
  });

  it('should validate secondary types', () => {
    expect(() => {
      normalizeFollowRules({
        excludeSecondary: ['Compilation', 'InvalidType' as any],
      });
    }).toThrow();
  });

  it('should allow merging partial updates', () => {
    const current: FollowRules = {
      includePrimary: ['Album'],
      excludeSecondary: ['Compilation', 'Live'],
      autoFollowMinAlbums: 2,
    };

    const update = normalizeFollowRules({
      includePrimary: ['Album', 'EP'],
      excludeSecondary: current.excludeSecondary,
    });

    expect(update.includePrimary).toContain('EP');
    expect(update.excludeSecondary).toContain('Live');
  });

  it('should deduplicate types', () => {
    const rules = normalizeFollowRules({
      includePrimary: ['Album', 'Album', 'EP'],
      excludeSecondary: ['Compilation', 'Compilation'],
    });

    const primaryCount = rules.includePrimary.filter((t) => t === 'Album').length;
    expect(primaryCount).toBe(1);

    const secondaryCount = rules.excludeSecondary.filter((t) => t === 'Compilation').length;
    expect(secondaryCount).toBe(1);
  });

  it('should sort types for consistency', () => {
    const rules1 = normalizeFollowRules({
      includePrimary: ['Single', 'Album', 'EP'],
    });

    const rules2 = normalizeFollowRules({
      includePrimary: ['Album', 'EP', 'Single'],
    });

    expect(rules1.includePrimary).toEqual(rules2.includePrimary);
  });
});
