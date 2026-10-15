import { describe, expect, it } from 'vitest';
import { legacyEnvTarget, migrateLegacyEnv } from './envFile.js';

describe('migrateLegacyEnv', () => {
  it('renames LINER_* keys, keeps values, comments and order', () => {
    const before = "# tagave\nAPP_SECRET=s\nLINER_LIBRARY_ID='lib 1'\n# a note\nLINER_QUEUES=scan.root\nTZ=UTC\n";
    const { text, notes } = migrateLegacyEnv(before);
    expect(text).toBe("# tagave\nAPP_SECRET=s\nTAGAVE_LIBRARY_ID='lib 1'\n# a note\nTAGAVE_QUEUES=scan.root\nTZ=UTC\n");
    expect(notes).toEqual(['LINER_LIBRARY_ID->TAGAVE_LIBRARY_ID', 'LINER_QUEUES->TAGAVE_QUEUES']);
  });

  it('lets a new name already set win and drops the old line', () => {
    const { text, notes } = migrateLegacyEnv('TAGAVE_ALLOW_SCHEMA_SKEW=1\nLINER_ALLOW_SCHEMA_SKEW=0\n');
    expect(text).toBe('TAGAVE_ALLOW_SCHEMA_SKEW=1\n');
    expect(notes).toEqual(['LINER_ALLOW_SCHEMA_SKEW (dropped: TAGAVE_ALLOW_SCHEMA_SKEW is set)']);
  });

  it('maps the two settings whose new names differ', () => {
    expect(legacyEnvTarget('LINER_VERSION')).toBe('TAGAVE_BUILD_VERSION');
    expect(legacyEnvTarget('LINER_BACKUP_DIR')).toBe('BACKUP_DIR');
    expect(legacyEnvTarget('LINER_PORT')).toBe('TAGAVE_PORT');
  });

  it('changes nothing in a current .env', () => {
    const env = 'TAGAVE_VERSION=0.9.0\nPOSTGRES_USER=tagave\n# LINER_QUEUES in a comment stays\n';
    expect(migrateLegacyEnv(env)).toEqual({ text: env, notes: [] });
  });
});
