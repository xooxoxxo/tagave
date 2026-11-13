import { describe, it, expect } from 'vitest';
import { LIVE_DATABASE_NAME, parseCliArgs, renderTraining, runCli } from './localDeciderTrain.js';

const LIB = '3f2a9c1e-5b7d-4e8f-9a6b-0c1d2e3f4a5b';

describe('localDeciderTrain command line', () => {
  it('parses train with its flags', () => {
    expect(parseCliArgs(['train', '--library', LIB, '--confirm-database', 'copy'])).toEqual({ command: 'train', library: LIB, confirmDatabase: 'copy', dryRun: false, copy: false });
    expect(parseCliArgs(['train', '--dry-run', '--library', LIB, '--confirm-database', 'copy', '--json', '/x.json', '--copy']))
      .toEqual({ command: 'train', library: LIB, confirmDatabase: 'copy', dryRun: true, copy: true, json: '/x.json' });
    expect(LIVE_DATABASE_NAME).toBe('tagave');
  });

  it('names what is wrong, never a value given', () => {
    expect(parseCliArgs([])).toEqual({ error: 'unknown command' });
    expect(parseCliArgs(['measure'])).toEqual({ error: 'unknown command' });
    expect(parseCliArgs(['train', '--confirm-database', 'x'])).toEqual({ error: '--library is required' });
    expect(parseCliArgs(['train', '--library', 'not-an-id', '--confirm-database', 'x'])).toEqual({ error: '--library must be a library id' });
    expect(parseCliArgs(['train', '--library', LIB])).toEqual({ error: '--confirm-database is required' });
    expect(parseCliArgs(['train', '--library', LIB, '--confirm-database'])).toEqual({ error: '--confirm-database needs a value' });
    expect(parseCliArgs(['train', '--library', LIB, '--seed', '3'])).toEqual({ error: 'unknown flag --seed' });
    expect(parseCliArgs(['train', 'secret-value'])).toEqual({ error: 'unknown argument' });
  });

  it('usage errors exit 2 before connecting', async () => {
    let err = '';
    const io = { stdout: { write: () => undefined }, stderr: { write: (s: string) => { err += s; } }, env: {} };
    expect(await runCli(['train'], io)).toBe(2);
    expect(err).toMatch(/--library is required\nusage: localDeciderTrain train/);
  });

  it('prints the counts and one line per band', () => {
    const band = (b: string, min: number, decided: number, wrong: number) => ({
      band: b, min, decided, coverage: decided / 100, wrongRelease: wrong, wrongAlbum: 0, errorRate: decided ? wrong / decided : null, errorUpper: 0.03,
    });
    const text = renderTraining({
      version: 'local@0123456789ab',
      counts: { albums: 200, rows: 600, owner: 100, auto: 100, rejections: 2 },
      metrics: {
        albums: 100, groupedAlbums: 90, folds: 5, seed: 7, cutoff: 0.9, margin: 0.3,
        bands: [band('p99', 0.99, 50, 0), band('p97', 0.97, 0, 0), band('p95', 0.95, 5, 1), band('p90', 0.9, 2, 0)],
        atOrAbove: [band('p99', 0.99, 50, 0), band('p97', 0.97, 50, 0), band('p95', 0.95, 55, 1), band('p90', 0.9, 57, 1)],
        undecided: 43, topPickRight: { right: 95, albums: 100, rate: 0.95 },
      },
    }, null);
    expect(text).toContain('albums 200  rows 600  owner 100  auto 100  rejections 2\n');
    expect(text).toContain('model local@0123456789ab  not stored\n');
    expect(text).toContain('held out: 100 owner albums (90 by tracklist group), 5 folds, seed 7, cut-off 0.9, margin 0.3\n');
    expect(text).toMatch(/\np99 +50 +50\.0% +0 +0 +0\.0% +3\.0%\n/);
    expect(text).toMatch(/\np97 +0 +0\.0% +0 +0 +- +3\.0%\n/);
    expect(text).toMatch(/\n>=p90 +57 +57\.0% +1 +0 +1\.8% +3\.0%\n/);
    expect(text).toContain('undecided 43    top pick right 95/100 (95.0%)\n');
  });
});
