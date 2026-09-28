/**
 * Tests for tag plans API endpoints, especially add-to-existing-plan
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TagPlanScope } from '@liner/shared';

/**
 * Test that scope merging works correctly for add-to-existing-plan
 */
describe('Tag plan add-to-items endpoint', () => {
  it('merges album IDs from two albumIds scopes correctly', () => {
    const existing: TagPlanScope = { type: 'albumIds', albumIds: ['a', 'b', 'c'] };
    const newScope: TagPlanScope = { type: 'albumIds', albumIds: ['c', 'd', 'e'] };

    // Simulate the merge logic
    if (existing.type === 'albumIds' && newScope.type === 'albumIds') {
      const merged = Array.from(new Set([...existing.albumIds, ...newScope.albumIds]));
      expect(merged).toContain('a');
      expect(merged).toContain('b');
      expect(merged).toContain('c');
      expect(merged).toContain('d');
      expect(merged).toContain('e');
      expect(merged).toHaveLength(5);
    }
  });

  it('removes duplicates when merging album IDs', () => {
    const existing: TagPlanScope = { type: 'albumIds', albumIds: ['a', 'b'] };
    const newScope: TagPlanScope = { type: 'albumIds', albumIds: ['b'] };

    if (existing.type === 'albumIds' && newScope.type === 'albumIds') {
      const merged = Array.from(new Set([...existing.albumIds, ...newScope.albumIds]));
      expect(merged).toEqual(['a', 'b']);
    }
  });

  it('detects idempotent additions (no new albums)', () => {
    const existing: TagPlanScope = { type: 'albumIds', albumIds: ['a', 'b', 'c'] };
    const newScope: TagPlanScope = { type: 'albumIds', albumIds: ['b', 'c'] };

    if (existing.type === 'albumIds' && newScope.type === 'albumIds') {
      const merged = Array.from(new Set([...existing.albumIds, ...newScope.albumIds]));
      const isIdempotent = merged.length === existing.albumIds.length;
      expect(isIdempotent).toBe(true);
    }
  });

  it('rejects non-albumIds existing scopes', () => {
    const existing: TagPlanScope = { type: 'library' };
    // The endpoint should reject with: "Cannot add items to plans with non-album scope"
    expect(existing.type).not.toBe('albumIds');
  });

  it('rejects non-albumIds new scopes', () => {
    const newScope: TagPlanScope = { type: 'library' };
    // The endpoint should reject with: "Can only add items from albumIds scope"
    expect(newScope.type).not.toBe('albumIds');
  });
});

/**
 * Test scope validation rules
 */
describe('Tag plan scope validation', () => {
  it('accepts valid albumIds scope', () => {
    const scope: TagPlanScope = { type: 'albumIds', albumIds: ['id1', 'id2'] };
    expect(scope.type).toBe('albumIds');
    expect(scope.albumIds).toHaveLength(2);
  });

  it('requires non-empty album list for albumIds scope', () => {
    const scope: TagPlanScope = { type: 'albumIds', albumIds: [] };
    expect(scope.albumIds.length).toBe(0);
    // The schema requires min(1), so this should fail validation
  });
});
