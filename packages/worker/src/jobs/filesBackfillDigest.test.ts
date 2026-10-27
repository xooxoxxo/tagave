import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { filesBackfillDigestJob } from './filesBackfillDigest.js';

/**
 * A library-sized run against a stubbed client: the select pages by id
 * (keyset, no OFFSET) and every update binds whole arrays, never one
 * parameter per row (Postgres allows 65,535 bind parameters).
 */
describe('files.backfillDigest (stubbed)', () => {
  it('pages a 240k-row library by id and binds one array per column', async () => {
    const total = 240_000;
    const id = (i: number) => `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`;
    const tagged = { common: { title: 'Song', artist: 'Band', track: { no: 1 } } };
    const untagged = { common: {} };
    const selects: Array<{ after: string; limit: number; text: string }> = [];
    let updates = 0; let updatedRows = 0;
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('select id, handler, tags_raw')) {
        const after = values[0] as string; const limit = values[1] as number;
        selects.push({ after, limit, text });
        const start = after === '00000000-0000-0000-0000-000000000000' ? 0 : Number(after.slice(-12));
        const rows = [];
        for (let i = start; i < Math.min(total, start + limit); i++) {
          rows.push({ id: id(i), handler: 'audio', tags_raw: i % 10 === 0 ? untagged : tagged, tags_digest: 'td' });
        }
        return rows;
      }
      expect(values).toHaveLength(3);
      for (const v of values) expect(Array.isArray(v)).toBe(true);
      updates += 1; updatedRows += (values[0] as unknown[]).length;
      return Object.assign([], { count: (values[0] as unknown[]).length });
    }) as any;

    const r = await filesBackfillDigestJob({ sql, logger: pino({ level: 'silent' }) }, {});
    expect(r.updated).toBe(total * 0.9);
    expect(updatedRows).toBe(total * 0.9);
    expect(updates).toBe(240);
    // 240 full pages, then one empty select ends the run
    expect(selects).toHaveLength(241);
    expect(selects.every((s) => s.limit === 1000 && !/offset/i.test(s.text))).toBe(true);
    expect(selects[1]!.after).toBe(id(999));
  });
});
