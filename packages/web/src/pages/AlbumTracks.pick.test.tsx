/**
 * Maintenance, the owner: each song of the album page carries a checkbox
 * (Move to album, Delete); outside Maintenance, or for anyone else, none.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { AlbumTracks } from './AlbumTracks';
import type { DetailTrack } from './albumDetailTypes';

const track = (id: string, no: number, title: string): DetailTrack => ({
  id, discNo: 1, trackNo: no, title, durationMs: 300_000, origin: 'file', cueStartMs: null, canonicalTitle: null, canonicalDurationMs: null,
  file: { relPath: `Enslaved/Vertebrae/${no} - ${title}.flac`, codec: 'FLAC', lossless: true, bitrateKbps: null, sampleRate: 44100, bitDepth: 16, sizeBytes: 1, status: 'present' },
});
const tracks = [track('t1', 1, 'Clouds'), track('t2', 2, 'Isa')];
const render = (maintenance: boolean, pick: { selected: ReadonlySet<string>; onToggle: (id: string) => void } | null) =>
  renderToStaticMarkup(createElement(AlbumTracks, {
    tracks, missingTracks: [{ disc: 1, position: 3, title: 'Ground', lengthMs: 1 }], discCount: 1, albumArtists: ['Enslaved'], artistNames: ['Enslaved'], maintenance, pick,
  }));

describe('the songs picked in Maintenance', () => {
  it('a checkbox per song, checked when picked; the missing rows keep the column empty', () => {
    const html = render(true, { selected: new Set(['t2']), onToggle: () => undefined });
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Select Isa" checked=""');
    expect(html).not.toContain('aria-label="Select Clouds" checked=""');
    expect(html.match(/data-picked=""/g)).toHaveLength(1);
    expect(html).toContain('Ground');
  });

  it('none outside Maintenance, and none without the owner', () => {
    expect(render(false, { selected: new Set(['t2']), onToggle: () => undefined })).not.toContain('checkbox');
    expect(render(true, null)).not.toContain('checkbox');
  });
});
