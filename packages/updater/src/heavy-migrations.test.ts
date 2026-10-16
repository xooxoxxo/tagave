import { describe, expect, it } from 'vitest';
import { HEAVY_MIGRATIONS, pendingHeavy } from './heavy-migrations.js';

describe('heavy migrations', () => {
  it('finds the pending ones by file name, whatever their number', () => {
    const image = '0045_player_retired_accounts.sql\n0046_cover_thumbs.sql\n0047_other.sql\nREADME\n';
    expect(pendingHeavy(image, '0045_player_retired_accounts.sql\n').map((p) => p.name)).toEqual(['0046_cover_thumbs.sql']);
    expect(pendingHeavy('0049_cover_thumbs.sql\n', '').map((p) => p.name)).toEqual(['0049_cover_thumbs.sql']);
  });

  it('skips the applied ones, and names that only look alike', () => {
    expect(pendingHeavy('0046_cover_thumbs.sql\n', '0046_cover_thumbs.sql\n')).toEqual([]);
    expect(pendingHeavy('0046_cover_thumbs_drop.sql\n0046_cover_thumbs.sql.bak\n', '')).toEqual([]);
  });

  it('measures the cover thumbnails three times over, with a query free of double quotes', () => {
    const m = HEAVY_MIGRATIONS.find((h) => h.file.test('0046_cover_thumbs.sql'))!;
    expect(m.factor).toBe(3);
    expect(m.bytesSql).not.toContain('"');
  });
});
