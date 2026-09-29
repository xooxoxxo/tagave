import { describe, expect, it } from 'vitest';
import { backAction, isDetailPath, parentLabel, parentPath } from './backNav';
import { isMaintenanceShortcut } from '../maintenance';
import { trackArtistIfDifferent } from '../pages/albumFormat';
import { trackEntries } from '../pages/AlbumTracks';

describe('back button target', () => {
  it('top-level pages have no back button (the mark shows)', () => {
    for (const p of ['/', '/albums', '/artists', '/collection', '/work', '/plans', '/settings', '/settings/library', '/settings/appearance']) {
      expect(parentPath(p)).toBeNull();
      expect(isDetailPath(p)).toBe(false);
      expect(backAction(p, true)).toBeNull();
    }
  });

  it('detail pages know their parent list', () => {
    expect(parentPath('/albums/123')).toBe('/albums');
    expect(parentPath('/albums/123/')).toBe('/albums');
    expect(parentPath('/artists/abc')).toBe('/artists');
    expect(parentPath('/plans/p1')).toBe('/plans');
    expect(parentLabel('/albums')).toBe('Albums');
    expect(parentLabel('/plans')).toBe('Tag changes');
  });

  it('returns to where the viewer came from inside the app', () => {
    expect(backAction('/albums/123', true)).toEqual({ kind: 'history' });
  });

  it('falls back to the parent list when opened cold', () => {
    expect(backAction('/albums/123', false)).toEqual({ kind: 'navigate', to: '/albums' });
    expect(backAction('/artists/abc', false)).toEqual({ kind: 'navigate', to: '/artists' });
  });
});

describe('Maintenance shortcut', () => {
  const key = (k: string, over: Partial<KeyboardEvent> = {}) => ({ key: k, shiftKey: true, metaKey: false, ctrlKey: false, altKey: false, ...over });
  it('is Shift+M outside text fields', () => {
    expect(isMaintenanceShortcut(key('M'), null)).toBe(true);
    expect(isMaintenanceShortcut(key('M', { shiftKey: false }), null)).toBe(false);
    expect(isMaintenanceShortcut(key('M', { metaKey: true }), null)).toBe(false);
    expect(isMaintenanceShortcut(key('M'), { tagName: 'INPUT' } as unknown as EventTarget)).toBe(false);
    expect(isMaintenanceShortcut(key('M'), { tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(false);
  });
});

describe('track rows', () => {
  it('names the track artist only when it is not the album artist', () => {
    expect(trackArtistIfDifferent('Nina Simone', ['Various Artists'])).toBe('Nina Simone');
    expect(trackArtistIfDifferent('Xiu Xiu', ['Xiu Xiu'])).toBeNull();
    expect(trackArtistIfDifferent('  xiu  xiu ', ['Xiu Xiu'])).toBeNull();
    expect(trackArtistIfDifferent('Xiu Xiu + Eugene S. Robinson', ['Xiu Xiu, Eugene S. Robinson'], ['Xiu Xiu', 'Eugene S. Robinson'])).toBeNull();
    expect(trackArtistIfDifferent('Xiu Xiu feat. Guest', ['Xiu Xiu'], ['Xiu Xiu'])).toBe('Xiu Xiu feat. Guest');
    expect(trackArtistIfDifferent(null, ['X'])).toBeNull();
  });

  it('slots missing tracks between the ones you have, per disc', () => {
    const t = (id: string, disc: number, no: number) => ({ id, discNo: disc, trackNo: no, title: id, durationMs: 1, origin: 'file', cueStartMs: null, canonicalTitle: null, canonicalDurationMs: null, file: { relPath: id, codec: null, lossless: null, bitrateKbps: null, sampleRate: null, bitDepth: null, sizeBytes: null, status: 'ok' } });
    const groups = trackEntries([t('a', 1, 1), t('c', 1, 3), t('d', 2, 1)], [{ disc: 1, position: 2, title: 'b', lengthMs: null }, { disc: 2, position: 2, title: 'e', lengthMs: null }]);
    expect(groups.map((g) => [g.disc, g.entries.map((e) => e.key)])).toEqual([
      [1, ['a', 'm-1-2', 'c']],
      [2, ['d', 'm-2-2']],
    ]);
  });
});
