/**
 * Tests for artists.refresh sweep job (XO-343).
 */
import { describe, it, expect, vi } from 'vitest';
import { selectDueArtists, artistsRefreshSweepJob, type ArtistsRefreshSweepJobData } from './artistsRefreshSweep.js';
import type { WorkerContext } from '../lib/context.js';
import pino from 'pino';

interface DueArtistRow {
  artistId: string;
  lastRefreshedAt: Date | null;
}

describe('selectDueArtists', () => {
  const now = new Date('2024-01-15T00:00:00Z');

  it('should skip rows with lastRefreshedAt within 7 days', () => {
    const rows: DueArtistRow[] = [
      { artistId: '1', lastRefreshedAt: new Date('2024-01-08T00:00:00Z') }, // 7 days ago - include
      { artistId: '2', lastRefreshedAt: new Date('2024-01-09T00:00:00Z') }, // 6 days ago - skip
      { artistId: '3', lastRefreshedAt: new Date('2024-01-14T23:59:59Z') }, // ~1s ago - skip
    ];

    const result = selectDueArtists(rows, now, 10);

    expect(result).toHaveLength(1);
    expect(result[0]!.artistId).toBe('1');
  });

  it('should order by lastRefreshedAt with nulls first', () => {
    const rows: DueArtistRow[] = [
      { artistId: '1', lastRefreshedAt: new Date('2024-01-01T00:00:00Z') }, // oldest
      { artistId: '2', lastRefreshedAt: null }, // never refreshed - should be first
      { artistId: '3', lastRefreshedAt: null }, // never refreshed - should be first
      { artistId: '4', lastRefreshedAt: new Date('2024-01-07T00:00:00Z') }, // second oldest
    ];

    const result = selectDueArtists(rows, now, 10);

    // Nulls come first, then ordered by oldest refreshed
    expect(result[0]!.lastRefreshedAt).toBeNull();
    expect(result[1]!.lastRefreshedAt).toBeNull();
    expect(result[2]!.artistId).toBe('1');
    expect(result[3]!.artistId).toBe('4');
  });

  it('should respect the limit parameter', () => {
    const rows: DueArtistRow[] = [
      { artistId: '1', lastRefreshedAt: null },
      { artistId: '2', lastRefreshedAt: null },
      { artistId: '3', lastRefreshedAt: null },
      { artistId: '4', lastRefreshedAt: null },
      { artistId: '5', lastRefreshedAt: null },
    ];

    const result = selectDueArtists(rows, now, 3);

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.artistId)).toEqual(['1', '2', '3']);
  });

  it('should return empty when all rows are fresh', () => {
    const rows: DueArtistRow[] = [
      { artistId: '1', lastRefreshedAt: new Date('2024-01-10T00:00:00Z') }, // 5 days ago - skip
      { artistId: '2', lastRefreshedAt: new Date('2024-01-11T00:00:00Z') }, // 4 days ago - skip
    ];

    const result = selectDueArtists(rows, now, 10);

    expect(result).toHaveLength(0);
  });

  it('should handle mixed fresh and due rows', () => {
    const rows: DueArtistRow[] = [
      { artistId: '1', lastRefreshedAt: new Date('2024-01-14T00:00:00Z') }, // 1 day ago - skip
      { artistId: '2', lastRefreshedAt: new Date('2024-01-08T00:00:00Z') }, // 7 days ago - include
      { artistId: '3', lastRefreshedAt: new Date('2024-01-07T00:00:00Z') }, // 8 days ago - include
      { artistId: '4', lastRefreshedAt: null }, // never - include
    ];

    const result = selectDueArtists(rows, now, 10);

    expect(result).toHaveLength(3);
    expect(result[0]!.artistId).toBe('4'); // null first
    expect(result[1]!.artistId).toBe('3'); // oldest after nulls (2024-01-07)
    expect(result[2]!.artistId).toBe('2'); // newer (2024-01-08)
  });

  it('should return empty array when rows is empty', () => {
    const result = selectDueArtists([], now, 10);

    expect(result).toHaveLength(0);
  });

  it('should handle limit=0', () => {
    const rows: DueArtistRow[] = [
      { artistId: '1', lastRefreshedAt: null },
      { artistId: '2', lastRefreshedAt: null },
    ];

    const result = selectDueArtists(rows, now, 0);

    expect(result).toHaveLength(0);
  });
});

describe('artistsRefreshSweepJob', () => {
  it('should enqueue zero jobs when discographyRefreshEnabled is false', async () => {
    // Track calls for verification
    let bossCallCount = 0;
    const loggedMessages: string[] = [];

    // Create a properly mocked context
    const mockCtx: any = {
      db: {
        select: vi.fn((fields) => ({
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              // Return library settings with discographyRefreshEnabled = false
              {
                settings: {
                  discographyRefreshEnabled: false,
                },
              },
            ]),
          })),
        })),
      },
      boss: {
        send: vi.fn().mockImplementation(() => {
          bossCallCount++;
          return 'job-id';
        }),
      },
      logger: {
        info: vi.fn((data: any, msg: string) => {
          loggedMessages.push(msg);
        }),
        warn: vi.fn(),
      },
    };

    // Override the first select call to return libraries
    const selectCalls: any[] = [];
    const originalSelect = mockCtx.db.select;
    mockCtx.db.select = vi.fn((fields) => {
      selectCalls.push(fields);
      const callIndex = selectCalls.length;

      // First call: get libraries (when no where clause)
      if (callIndex === 1) {
        return {
          from: vi.fn().mockResolvedValue([{ id: 'lib-1' }]),
        };
      }

      // Subsequent calls: get settings (with where clause)
      return {
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            {
              settings: {
                discographyRefreshEnabled: false,
              },
            },
          ]),
        })),
      };
    });

    const data: ArtistsRefreshSweepJobData = {};

    // Call the job
    await artistsRefreshSweepJob(mockCtx, data);

    // Verify that no jobs were enqueued to boss.send
    expect(bossCallCount).toBe(0);

    // Verify the disabled log was called
    const disabledMessage = loggedMessages.find((msg) =>
      msg.includes('disabled')
    );
    expect(disabledMessage).toBeDefined();
  });
});
