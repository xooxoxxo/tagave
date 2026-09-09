/**
 * ⌘K search (BRW-4): one box over albums, artists, tracks; arrow keys to
 * move, Enter to open, Esc to close.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCurrentLibrary } from '../hooks';
import { api } from '../services/api';
import styles from './SearchModal.module.css';

interface SearchResult {
  albums: { id: string; title: string; artist: string | null; year: number | null; trackCount: number }[];
  artists: { id: string; name: string; albumCount: number }[];
  tracks: { id: string; title: string; albumId: string; albumTitle: string; artist: string | null }[];
}

type Row =
  | { type: 'album'; id: string; primary: string; secondary: string }
  | { type: 'artist'; id: string; primary: string; secondary: string }
  | { type: 'track'; albumId: string; primary: string; secondary: string };

export function SearchModal({ onClose }: { onClose: () => void }) {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 150);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ['search', libraryId, debounced],
    queryFn: () =>
      api.get<SearchResult>(`/libraries/${libraryId}/search?q=${encodeURIComponent(debounced)}`),
    enabled: !!libraryId && debounced.trim().length >= 2,
  });

  const rows: Row[] = useMemo(() => {
    if (!data || q.trim().length < 2 || q !== debounced) return [];
    return [
      ...data.albums.map<Row>((a) => ({
        type: 'album', id: a.id,
        primary: a.title,
        secondary: `${a.artist ?? 'Unknown'}${a.year ? ` · ${a.year}` : ''} · ${a.trackCount} tracks`,
      })),
      ...data.artists.map<Row>((a) => ({
        type: 'artist', id: a.id,
        primary: a.name,
        secondary: `${a.albumCount} album${a.albumCount === 1 ? '' : 's'}`,
      })),
      ...data.tracks.map<Row>((t) => ({
        type: 'track', albumId: t.albumId,
        primary: t.title,
        secondary: `${t.artist ?? 'Unknown'} — ${t.albumTitle}`,
      })),
    ];
  }, [data, q, debounced]);

  useEffect(() => setSelected(0), [rows.length, debounced]);

  const open = (row: Row) => {
    onClose();
    if (row.type === 'artist') {
      navigate({ to: '/artists/$artistId', params: { artistId: row.id } as never });
    } else {
      const albumId = row.type === 'album' ? row.id : row.albumId;
      navigate({ to: '/albums/$albumId', params: { albumId } as never });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      const focusable = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('input, button'));
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      focusable[(index + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
    }
    else if (e.key === 'Escape') onClose();
    else if (e.target !== inputRef.current) return;
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.max(0, Math.min(s + 1, rows.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter' && rows[selected]) {
      open(rows[selected]);
    }
  };

  const sections: { label: string; rows: { row: Row; index: number }[] }[] = useMemo(() => {
    const indexed = rows.map((row, index) => ({ row, index }));
    return [
      { label: 'Albums', rows: indexed.filter((r) => r.row.type === 'album') },
      { label: 'Artists', rows: indexed.filter((r) => r.row.type === 'artist') },
      { label: 'Tracks', rows: indexed.filter((r) => r.row.type === 'track') },
    ].filter((s) => s.rows.length > 0);
  }, [rows]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Search your library" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <button className={styles.closeButton} onClick={onClose} aria-label="Close search">Close <span aria-hidden="true">×</span></button>
        <input
          ref={inputRef}
          aria-label="Search albums, artists, and tracks"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls="search-results"
          aria-autocomplete="list"
          aria-activedescendant={rows[selected] ? `search-result-${selected}` : undefined}
          className={styles.input}
          placeholder="Search albums, artists, tracks..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {isFetching && <p className={styles.empty} role="status">Searching…</p>}
        {isError && <p className={styles.empty} role="alert">Search is unavailable. <button onClick={() => void refetch()}>Retry</button></p>}
        <div className={styles.results} id="search-results" role="listbox" aria-label="Search results">
          {sections.map((s) => (
            <div key={s.label}>
              <div className={styles.sectionLabel}>{s.label}</div>
              {s.rows.map(({ row, index }) => (
                <div
                  key={index}
                  id={`search-result-${index}`}
                  role="option"
                  aria-selected={index === selected}
                  className={index === selected ? styles.rowSelected : styles.row}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => open(row)}
                >
                  <span className={styles.primary}>{row.primary}</span>
                  <span className={styles.secondary}>{row.secondary}</span>
                </div>
              ))}
            </div>
          ))}
          {!isFetching && !isError && q === debounced && debounced.trim().length >= 2 && rows.length === 0 && (
            <div className={styles.empty}>No results for "{debounced}"</div>
          )}
          {debounced.trim().length < 2 && (
            <div className={styles.empty}>Type at least 2 characters…</div>
          )}
        </div>
      </div>
    </div>
  );
}
