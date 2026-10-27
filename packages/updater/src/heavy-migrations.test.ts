import { describe, expect, it } from 'vitest';
import { HEAVY_MIGRATIONS, LEDGER_ENTRIES_SQL, imageMigrationEntry, pendingHeavy } from './heavy-migrations.js';

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

  it('reads every chain of the image: the core folder and each app\u2019s and module\u2019s own', () => {
    const dir = '/app/packages/db/migrations';
    expect(imageMigrationEntry(`${dir}/0046_cover_thumbs.sql`)).toBe('0046_cover_thumbs.sql');
    expect(imageMigrationEntry(`${dir}/modules/decider/0001_big.sql`)).toBe('decider/0001_big.sql');
    expect(imageMigrationEntry(`${dir}/apps/books/0001_x.sql`)).toBe('books/0001_x.sql');
    expect(imageMigrationEntry(`${dir}/other/deep/x/0001.sql`)).toBeNull();
    expect(imageMigrationEntry('0046_cover_thumbs.sql')).toBe('0046_cover_thumbs.sql');
    const decider = [{ file: /^decider\/\d{4}_big\.sql$/, what: 'a big move', bytesSql: 'select 1', factor: 2 }];
    const image = `${dir}/0046_cover_thumbs.sql\n${dir}/modules/decider/0001_big.sql\n`;
    expect(pendingHeavy(image, '0046_cover_thumbs.sql\n', decider).map((p) => p.name)).toEqual(['decider/0001_big.sql']);
    expect(pendingHeavy(image, 'decider/0001_big.sql\n', decider)).toEqual([]);
    // a module's file never passes for the core file of the same name
    expect(pendingHeavy(`${dir}/modules/decider/0046_cover_thumbs.sql\n`, '')).toEqual([]);
    expect(LEDGER_ENTRIES_SQL).not.toContain('"');
  });

  it('measures the cover thumbnails three times over, with a query free of double quotes', () => {
    const m = HEAVY_MIGRATIONS.find((h) => h.file.test('0046_cover_thumbs.sql'))!;
    expect(m.factor).toBe(3);
    expect(m.bytesSql).not.toContain('"');
  });
});
