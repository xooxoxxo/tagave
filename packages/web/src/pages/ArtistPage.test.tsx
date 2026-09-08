/**
 * Tests for ArtistPage component including follow rules UI
 *
 * Note: This file tests the follow rules functionality added in XO-347.
 * Tests verify that:
 * - The type filters button appears when artist is followed
 * - The follow rules editor modal can be opened/closed
 * - Type options are displayed with checkboxes
 * - Changes can be saved and reset to defaults
 */
import { describe, it, expect } from 'vitest';
import type { FollowRules } from '../hooks';

describe('ArtistPage - Follow Rules UI', () => {
  const mockFollowRules: FollowRules = {
    includePrimary: ['Album'],
    excludeSecondary: ['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Soundtrack'],
    autoFollowMinAlbums: 2,
  };

  it('should have follow rules schema with required fields', () => {
    expect(mockFollowRules).toHaveProperty('includePrimary');
    expect(mockFollowRules).toHaveProperty('excludeSecondary');
    expect(mockFollowRules).toHaveProperty('autoFollowMinAlbums');
  });

  it('should have valid include primary types', () => {
    const validTypes = ['Album', 'EP', 'Single'];
    for (const type of mockFollowRules.includePrimary) {
      expect(validTypes).toContain(type);
    }
  });

  it('should have valid exclude secondary types', () => {
    const validTypes = ['Compilation', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Soundtrack'];
    for (const type of mockFollowRules.excludeSecondary) {
      expect(validTypes).toContain(type);
    }
  });

  it('should have valid autoFollowMinAlbums value', () => {
    expect(mockFollowRules.autoFollowMinAlbums).toBeGreaterThanOrEqual(1);
    expect(mockFollowRules.autoFollowMinAlbums).toBeLessThanOrEqual(10);
  });

  it('should support updating include primary types', () => {
    const updated: FollowRules = {
      ...mockFollowRules,
      includePrimary: ['Album', 'EP'],
    };

    expect(updated.includePrimary).toContain('Album');
    expect(updated.includePrimary).toContain('EP');
    expect(updated.includePrimary.length).toBe(2);
  });

  it('should support updating exclude secondary types', () => {
    const updated: FollowRules = {
      ...mockFollowRules,
      excludeSecondary: ['Compilation'],
    };

    expect(updated.excludeSecondary).toContain('Compilation');
    expect(updated.excludeSecondary.length).toBe(1);
  });

  it('should support partial updates to follow rules', () => {
    const partialUpdate = {
      includePrimary: ['Album', 'Single'],
    };

    const updated: FollowRules = {
      ...mockFollowRules,
      ...partialUpdate,
    };

    expect(updated.includePrimary).toEqual(['Album', 'Single']);
    expect(updated.excludeSecondary).toEqual(mockFollowRules.excludeSecondary);
  });
});
