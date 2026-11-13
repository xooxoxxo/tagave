export const ALBUM_WIDGETS = [
  { id: 'genre', label: 'Genre' },
  { id: 'year', label: 'Year' },
  { id: 'tracks', label: 'Tracks' },
  { id: 'duration', label: 'Length' },
  { id: 'format', label: 'Format' },
  { id: 'ownership', label: 'Your copy' },
] as const;

export type AlbumWidgetId = typeof ALBUM_WIDGETS[number]['id'];
export type WidgetPlacement = 'above' | 'below' | 'hidden';
export type AlbumWidgetLayout = Record<AlbumWidgetId, WidgetPlacement>;

export const DEFAULT_ALBUM_WIDGETS: AlbumWidgetLayout = {
  genre: 'above', year: 'above', tracks: 'below', duration: 'below', format: 'below', ownership: 'below',
};

export function parseAlbumWidgets(raw: unknown): AlbumWidgetLayout {
  const layout = { ...DEFAULT_ALBUM_WIDGETS };
  if (!raw || typeof raw !== 'object') return layout;
  const stored = raw as Record<string, unknown>;
  for (const { id } of ALBUM_WIDGETS) {
    const value = stored[id];
    if (value === 'above' || value === 'below' || value === 'hidden') layout[id] = value;
  }
  return layout;
}
