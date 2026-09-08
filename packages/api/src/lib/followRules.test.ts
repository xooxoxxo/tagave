import { describe, it, expect } from 'vitest';
import { followDefaultsFor } from './followRules.js';

const BUILT_IN_EXCLUDES = ['Compilation', 'DJ-mix', 'Demo', 'Live', 'Mixtape/Street', 'Remix', 'Soundtrack'];

describe('followDefaultsFor', () => {
  it('copies the library followRules', () => {
    expect(followDefaultsFor({ followRules: { includePrimary: ['Single', 'Album'], excludeSecondary: ['Live'] } }))
      .toEqual({ includePrimary: ['Album', 'Single'], excludeSecondary: ['Live'] });
  });

  it('falls back to the built-in defaults when the library set none', () => {
    expect(followDefaultsFor({})).toEqual({ includePrimary: ['Album'], excludeSecondary: BUILT_IN_EXCLUDES });
    expect(followDefaultsFor(null)).toEqual({ includePrimary: ['Album'], excludeSecondary: BUILT_IN_EXCLUDES });
  });

  it('falls back to the built-in defaults when the stored rules no longer validate', () => {
    expect(followDefaultsFor({ followRules: { includePrimary: ['Bootleg'] } }))
      .toEqual({ includePrimary: ['Album'], excludeSecondary: BUILT_IN_EXCLUDES });
  });

  it('accepts settings stored as a JSON string', () => {
    expect(followDefaultsFor(JSON.stringify({ followRules: { includePrimary: ['EP'] } })).includePrimary).toEqual(['EP']);
    expect(followDefaultsFor('{not json').includePrimary).toEqual(['Album']);
  });

  it('returns fresh arrays, not the shared defaults', () => {
    const a = followDefaultsFor({});
    a.includePrimary.push('EP');
    expect(followDefaultsFor({}).includePrimary).toEqual(['Album']);
  });
});
