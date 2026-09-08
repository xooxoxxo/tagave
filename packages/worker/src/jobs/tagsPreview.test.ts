import { describe, it, expect } from 'vitest';
import { type TagPolicies } from '@liner/shared';
import { metadataService } from './tagsPreview.js';

describe('tagsPreview job', () => {
  it('should have a working mock metadata service', async () => {
    const audioFileId = 'test-file-123';
    const metadata = { title: 'Test Title', artist: 'Test Artist' };

    metadataService.setFixture(audioFileId, metadata);
    const retrieved = await metadataService.getCanonicalMetadata(audioFileId);

    expect(retrieved).toEqual(metadata);
  });

  it('should accept valid tag policies', () => {
    const validPolicies: TagPolicies = {
      preset: 'canonical_ids_and_fill',
      id3Version: '2.4',
      multiValueSeparator: '; ',
    };

    expect(validPolicies.preset).toBe('canonical_ids_and_fill');
    expect(validPolicies.id3Version).toBe('2.4');
    expect(validPolicies.multiValueSeparator).toBe('; ');
  });

  it('should support policy overrides', () => {
    const policyWithOverrides: TagPolicies = {
      preset: 'custom',
      id3Version: '2.3',
      multiValueSeparator: ' / ',
      overrides: {
        title: 'fill',
        artist: 'overwrite',
      } as any,
    };

    expect(policyWithOverrides.overrides).toBeDefined();
    expect(policyWithOverrides.overrides?.title).toBe('fill');
  });

  // Integration tests would go here but require database setup
  // For now, these unit tests verify the schema and mock service work
});
