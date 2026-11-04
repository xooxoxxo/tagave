/**
 * ⌘K search (BRW-4): one box over albums, artists, tracks; arrow keys to
 * move, Enter to open, Esc to close. On a list page (Albums, Artists) the
 * first row narrows that list to the words typed ("In albums"), so the
 * header's search is the page's search too (utils/pageSearch.ts). A track
 * has every song's ⋮ beside it (TrackActions); going to its album or
 * artist from there closes the search.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCurrentLibrary } from '../hooks';
import { api } from '../services/api';
import { Button } from './ui';
import { TrackActions } from './player/TrackActions';
import styles from './SearchModal.module.css';

export interface SearchResult {
  albums: { id: string; title: string; artist: string | null; year: number | null; trackCount: number }[];
  artists: { id: string | null; name: string; albumCount: number }[];
  tracks: { id: string; title: string; albumId: string; albumTitle: string; artist: string | null }[];
}

export type Row =
  | { type: 'scope'; primary: string; secondary: string }
  | { type: 'album'; id: string; primary: string; secondary: string }
  | { type: 'artist'; id: string | null; primary: string; secondary: string }
  | { type: 'track'; id: string; albumId: string; albumTitle: string; primary: string; secondary: string };

export interface SearchScope {
  /** the group's heading: "In albums" */
  label: string;
  /** narrow the page's list to these words */
  onPick: (q: string) => void;
}

/**
 * The rows, in order: the page's own list first ("In albums", as soon as a
 * word is typed), then albums, artists and tracks once the search for the
 * words typed has answered (`settled`: the box holds what was searched).
 */
export function searchRows(data: SearchResult | undefined, words: string, settled: boolean, scoped: boolean): Row[] {
  const first: Row[] = scoped && words ? [{ type: 'scope', primary: `“${words}”`, secondary: '' }] : [];
  if (!data || words.length < 2 || !settled) return first;
  return [
    ...first,
    ...data.albums.map<Row>((a) => ({
      type: 'album', id: a.id,
      primary: a.title,
      secondary: `${a.artist ?? 'Unknown'}${a.year ? ` · ${a.year}` : ''} · ${a.trackCount} ${a.trackCount === 1 ? 'track' : 'tracks'}`,
    })),
    ...data.artists.map<Row>((a) => ({
      type: 'artist', id: a.id,
      primary: a.name,
      secondary: `${a.albumCount} album${a.albumCount === 1 ? '' : 's'}${a.id ? '' : ' · from tags'}`,
    })),
    ...data.tracks.map<Row>((t) => ({
      type: 'track', id: t.id, albumId: t.albumId, albumTitle: t.albumTitle,
      primary: t.title,
      secondary: `${t.artist ?? 'Unknown'} — ${t.albumTitle}`,
    })),
  ];
}

export function SearchModal({ onClose, scope }: { onClose: () => void; scope?: SearchScope | null | undefined }) {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
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

  const words = q.trim();
  const rows: Row[] = useMemo(() => searchRows(data, words, q === debounced, !!scope), [data, q, debounced, scope, words]);

  useEffect(() => setSelected(0), [rows.length, debounced]);

  // Scroll selected row into view
  useEffect(() => {
    if (!resultsRef.current || rows.length === 0) return;
    const selectedElement = resultsRef.current.querySelector(
      `#search-result-${selected}`
    ) as HTMLElement | null;
    selectedElement?.scrollIntoView({ block: 'nearest' });
  }, [selected, rows.length]);

  const open = (row: Row) => {
    onClose();
    if (row.type === 'scope') {
      scope?.onPick(words);
    } else if (row.type === 'artist' && row.id) {
      navigate({ to: '/artists/$artistId', params: { artistId: row.id } as never });
    } else if (row.type === 'artist') {
      // Tag-only artist (no linked identity yet): open their albums.
      navigate({ to: '/albums', search: { artist: row.primary } as never });
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
      // focus goes back to the header's search key as this closes: the
      // Enter must not go on to press it and open the search again
      e.preventDefault();
      open(rows[selected]);
    }
  };

  const sections: { label: string; rows: { row: Row; index: number }[] }[] = useMemo(() => {
    const indexed = rows.map((row, index) => ({ row, index }));
    return [
      { label: scope?.label ?? '', rows: indexed.filter((r) => r.row.type === 'scope') },
      { label: 'Albums', rows: indexed.filter((r) => r.row.type === 'album') },
      { label: 'Artists', rows: indexed.filter((r) => r.row.type === 'artist') },
      { label: 'Tracks', rows: indexed.filter((r) => r.row.type === 'track') },
    ].filter((s) => s.rows.length > 0);
  }, [rows, scope]);

  const shouldShowResults = (!!scope && words.length > 0) || (words.length >= 2 && (rows.length > 0 || !isFetching));
  const hasSearched = q === debounced && words.length >= 2;
  const found = rows.some((r) => r.type !== 'scope');

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Search your library" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className={styles.inputContainer}>
          <svg className={styles.searchIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            aria-label="Search albums, artists, and tracks"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="search-results"
            aria-autocomplete="list"
            aria-activedescendant={rows[selected] ? `search-result-${selected}` : undefined}
            className={styles.input}
            placeholder="Search albums, artists, tracks…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className={styles.escHint}>esc</div>
          {isFetching && <div className={styles.loadingBar} role="status" aria-label="Searching" />}
        </div>
        {isError && (
          <div className={styles.error} role="alert">
            Search is unavailable. <Button variant="quiet" size="sm" onClick={() => void refetch()}>Retry</Button>
          </div>
        )}
        {shouldShowResults && (
          <div className={styles.results} id="search-results" role="listbox" aria-label="Search results" ref={resultsRef}>
            {sections.map((s) => (
              <div key={s.label}>
                <div className={styles.sectionLabel}>{s.label}</div>
                {s.rows.map(({ row, index }) => {
                  const option = (
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
                      {row.secondary && <span className={styles.secondary}>{row.secondary}</span>}
                    </div>
                  );
                  if (row.type !== 'track') return option;
                  return (
                    <div key={index} className={styles.trackRow} role="presentation" onMouseEnter={() => setSelected(index)}>
                      {option}
                      {/* the menu's own keys (it is portalled; React still bubbles them here) stay in the menu */}
                      <span className={styles.trackMenu} onKeyDown={(e) => { if (!e.currentTarget.contains(e.target as Node)) e.stopPropagation(); }}>
                        <TrackActions
                          label={`More for ${row.primary}`}
                          summary={{ title: row.primary, subtitle: row.secondary, coverUrl: null }}
                          source={{ trackIds: [row.id] }}
                          albumId={row.albumId}
                          onAction={(key) => { if (key === 'album' || key === 'artist') onClose(); }}
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
            {hasSearched && !found && !isFetching && !isError && (
              <div className={styles.noResults}>No results for "{debounced}"</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
