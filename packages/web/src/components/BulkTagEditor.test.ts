import { describe, it, expect } from 'vitest';
import { formFromSuggestion, valuesFromForm } from './BulkTagEditor';
import type { TagEditSuggestion } from '../hooks/useCompilations';

const hotelCostes: TagEditSuggestion = {
  albumIds: ['a'],
  files: 3,
  albums: 1,
  current: {
    albumartist: [{ value: '01. Stephane Pompougnac', files: 1 }, { value: '02. Stephane Pompougnac', files: 1 }, { value: '03. Stephane Pompougnac', files: 1 }],
    album: [{ value: 'Hotel Costes Vol. 11', files: 3 }],
    artist: [{ value: 'Lena Horne', files: 1 }, { value: 'Morten Varano', files: 1 }, { value: 'Vanessa Da Mata', files: 1 }],
    date: [{ value: '2008', files: 3 }],
    genre: [],
    compilation: { yes: 0, no: 3 },
  },
  numberedAlbumArtists: 3,
  trackArtistsDiffer: true,
  suggested: { albumartist: 'Stephane Pompougnac', album: 'Hotel Costes Vol. 11', date: '2008', compilation: '1' },
  albumArtistOptions: ['Various Artists'],
  notes: [],
};

describe('bulk tag editor form', () => {
  it('ticks only what would change; per-track artist stays off', () => {
    const form = formFromSuggestion(hotelCostes);
    expect(form.albumartist).toEqual({ value: 'Stephane Pompougnac', on: true });
    expect(form.album.on).toBe(false); // every file already says so
    expect(form.date.on).toBe(false);
    expect(form.artist.on).toBe(false);
    expect(form.compilation).toBe('1');
    expect(valuesFromForm(form)).toEqual({ albumartist: 'Stephane Pompougnac', compilation: '1' });
  });

  it('turns the form into manual values, genres split, bad dates refused', () => {
    const form = formFromSuggestion(hotelCostes);
    const v = valuesFromForm({
      ...form,
      albumartist: { value: ' Various Artists ', on: true },
      genre: { value: 'Lounge; Downtempo, Lounge', on: true },
      artist: { value: 'Ignored', on: false },
      compilation: 'leave',
    });
    expect(v).toEqual({ albumartist: 'Various Artists', genre: ['Lounge', 'Downtempo'] });
    expect(() => valuesFromForm({ ...form, date: { value: '08', on: true } })).toThrow(/2008/);
  });
});
