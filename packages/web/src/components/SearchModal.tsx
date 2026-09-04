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
  artists: { name: string; albumCount: number }[];
  tracks: { id: string; title: string; albumId: string; albumTitle: string; artist: string | null }[];
}

type Row =
  | { type: 'album'; id: string; primary: string; secondary: string }
  | { type: 'artist'; name: string; primary: string; secondary: string }
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

  const { data } = useQuery({
    queryKey: ['search', libraryId, debounced],
    queryFn: () =>
      api.get<SearchResult>(`/libraries/${libraryId}/search?q=${encodeURIComponent(debounced)}`),
    enabled: !!libraryId && debounced.trim().length >= 2,
    placeholderData: (prev) => prev,
  });

  const rows: Row[] = useMemo(() => {
    if (!data) return [];
    return [
      ...data.albums.map<Row>((a) => ({
        type: 'album', id: a.id,
        primary: a.title,
        secondary: `${a.artist ?? 'Unknown'}${a.year ? ` · ${a.year}` : ''} · ${a.trackCount} tracks`,
      })),
      ...data.artists.map<Row>((a) => ({
        type: 'artist', name: a.name,
        primary: a.name,
        secondary: `${a.albumCount} album${a.albumCount === 1 ? '' : 's'}`,
      })),
      ...data.tracks.map<Row>((t) => ({
        type: 'track', albumId: t.albumId,
        primary: t.title,
        secondary: `${t.artist ?? 'Unknown'} — ${t.albumTitle}`,
      })),
    ];
  }, [data]);

  useEffect(() => setSelected(0), [rows.length, debounced]);

  const open = (row: Row) => {
    onClose();
    if (row.type === 'artist') {
      navigate({ to: '/albums', search: { artist: row.name } as never });
    } else {
      const albumId = row.type === 'album' ? row.id : row.albumId;
      navigate({ to: '/albums/$albumId', params: { albumId } as never });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, rows.length - 1));
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
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className={styles.input}
          placeholder="Search albums, artists, tracks..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className={styles.results}>
          {sections.map((s) => (
            <div key={s.label}>
              <div className={styles.sectionLabel}>{s.label}</div>
              {s.rows.map(({ row, index }) => (
                <div
                  key={index}
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
          {debounced.trim().length >= 2 && rows.length === 0 && (
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
