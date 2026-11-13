/**
 * ⌘K search (BRW-4): one box over albums, artists, songs (and playlists);
 * arrow keys to move, Enter to open, Esc to close. On a list page (Albums,
 * Artists) the first row narrows that list to the words typed ("In
 * albums"), so the header's search is the page's search too
 * (utils/pageSearch.ts). A song has every song's ⋮ beside it
 * (TrackActions); going to its album or artist from there closes the search.
 *
 * The box's grammar (searchGrammar.ts): `@artist` and the other kinds turn
 * into a chip in front of the words and narrow the results to that kind;
 * `/play`, `/queue` and `/shuffle` turn into a chip and Enter does that to
 * the highlighted result; `/go` and `/theme` offer their choices. Tab takes
 * the highlighted suggestion; Backspace in an empty box takes the last chip off.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { PlaylistSummary, PlaylistView } from '@tagave/shared';
import { useCan, useCurrentLibrary } from '../hooks';
import { useCapabilities } from '../hooks/usePlayer';
import { usePlaylists, usePlaylistsOn } from '../hooks/usePlaylists';
import { api } from '../services/api';
import { enqueue, playAlbum, playTracks, type QueueSource } from '../player/engine';
import { setThemePreference } from '../theme';
import { Button, HeartIcon, showToast } from './ui';
import { useLikeSets } from '../hooks/useLikes';
import { useDjViewAvailability } from '../hooks/useDj';
import { TrackActions } from './player/TrackActions';
import {
  EMPTY_INPUT, absorb, actDef, apiKind, dropChip, fold, scopeDef, shownKinds, suggestions,
  type ActKind, type GoTarget, type GrammarContext, type ScopeKind, type SearchInput, type Suggestion,
} from './searchGrammar';
import styles from './SearchModal.module.css';

export interface SearchResult {
  albums: { id: string; title: string; artist: string | null; year: number | null; trackCount: number }[];
  artists: { id: string | null; name: string; albumCount: number }[];
  tracks: { id: string; title: string; albumId: string; albumTitle: string; artist: string | null }[];
  /** only when the search was narrowed to labels (`?kind=labels`) */
  labels?: { name: string; albumCount: number }[];
}

export type Row =
  | { type: 'scope'; primary: string; secondary: string }
  | { type: 'album'; id: string; primary: string; secondary: string; artist: string | null }
  | { type: 'artist'; id: string | null; primary: string; secondary: string }
  | { type: 'track'; id: string; albumId: string; albumTitle: string; primary: string; secondary: string; artist: string | null }
  | { type: 'playlist'; id: string; primary: string; secondary: string }
  | { type: 'label'; primary: string; secondary: string }
  | Suggestion;

export interface SearchScope {
  /** the group's heading: "In albums" */
  label: string;
  /** narrow the page's list to these words */
  onPick: (q: string) => void;
  /** the kind of the page's list: an `@album` chip on Albums keeps "In albums" */
  kind?: ScopeKind | undefined;
}

const albumsWord = (n: number) => `${n} album${n === 1 ? '' : 's'}`;

export interface RowOptions {
  /** the kinds shown (searchGrammar shownKinds): all but labels by default */
  kinds?: ReadonlySet<ScopeKind>;
  /** the person's playlists, matched here by name */
  playlists?: readonly PlaylistSummary[] | undefined;
}

/**
 * The rows, in order: the page's own list first ("In albums", as soon as a
 * word is typed), then albums, artists, songs, playlists and labels once the
 * search for the words typed has answered (`settled`: the box holds what
 * was searched).
 */
export function searchRows(data: SearchResult | undefined, words: string, settled: boolean, scoped: boolean, opts: RowOptions = {}): Row[] {
  const kinds = opts.kinds ?? new Set<ScopeKind>(['album', 'artist', 'song', 'playlist']);
  const first: Row[] = scoped && words ? [{ type: 'scope', primary: `“${words}”`, secondary: '' }] : [];
  const folded = fold(words);
  const playlists: Row[] = kinds.has('playlist') && words.length >= 2
    ? (opts.playlists ?? []).filter((p) => fold(p.name).includes(folded)).slice(0, 8).map((p) => ({
      type: 'playlist', id: p.id, primary: p.name, secondary: `${p.tracks} ${p.tracks === 1 ? 'song' : 'songs'}`,
    }))
    : [];
  if (!data || words.length < 2 || !settled) return [...first, ...playlists];
  return [
    ...first,
    ...(kinds.has('album') ? data.albums : []).map<Row>((a) => ({
      type: 'album', id: a.id, artist: a.artist,
      primary: a.title,
      secondary: `${a.artist ?? 'Unknown'}${a.year ? ` · ${a.year}` : ''} · ${a.trackCount} ${a.trackCount === 1 ? 'track' : 'tracks'}`,
    })),
    ...(kinds.has('artist') ? data.artists : []).map<Row>((a) => ({
      type: 'artist', id: a.id,
      primary: a.name,
      secondary: `${albumsWord(a.albumCount)}${a.id ? '' : ' · from tags'}`,
    })),
    ...(kinds.has('song') ? data.tracks : []).map<Row>((t) => ({
      type: 'track', id: t.id, albumId: t.albumId, albumTitle: t.albumTitle, artist: t.artist,
      primary: t.title,
      secondary: `${t.artist ?? 'Unknown'} — ${t.albumTitle}`,
    })),
    ...playlists,
    ...(kinds.has('label') ? data.labels ?? [] : []).map<Row>((l) => ({ type: 'label', primary: l.name, secondary: albumsWord(l.albumCount) })),
  ];
}

const SECTION: Partial<Record<Row['type'], string>> = {
  album: 'Albums', artist: 'Artists', track: 'Songs', playlist: 'Playlists', label: 'Labels',
};
const ACTABLE = new Set<Row['type']>(['album', 'track', 'playlist']);

/** Play, Add to queue or Shuffle one result: what the album page, a song's ⋮ and a playlist's page do. */
async function runAct(act: ActKind, row: Row): Promise<void> {
  if (row.type === 'album') {
    const ref = { albumId: row.id, title: row.primary, artist: row.artist ?? '', coverUrl: null };
    if (act === 'queue') await queue({ albumId: row.id });
    else await playAlbum(ref, null, { shuffle: act === 'shuffle' });
  } else if (row.type === 'track') {
    if (act === 'queue') await queue({ trackIds: [row.id] });
    else await playAlbum({ albumId: row.albumId, title: row.albumTitle, artist: row.artist ?? '', coverUrl: null }, row.id);
  } else if (row.type === 'playlist') {
    const view = await api.get<PlaylistView>(`/me/playlists/${encodeURIComponent(row.id)}`);
    const ids = view.items.map((i) => i.localTrackId).filter((x): x is string => !!x);
    if (act === 'queue') await queue({ trackIds: ids });
    else await playTracks(ids, { kind: 'playlist', id: view.id, name: view.name }, { shuffle: act === 'shuffle' });
  }
}

/** Add to queue, said on a toast like a song's ⋮ does; playing shows in the player itself. */
async function queue(source: QueueSource): Promise<void> {
  const n = await enqueue(source, 'end');
  if (n > 0) showToast({ message: 'Added to queue' });
}

const GO_PATH: Record<GoTarget, string> = {
  albums: '/albums', artists: '/artists', collection: '/collection', playlists: '/playlists', settings: '/settings',
};

export function SearchModal({ onClose, scope }: { onClose: () => void; scope?: SearchScope | null | undefined }) {
  const { libraryId } = useCurrentLibrary();
  const navigate = useNavigate();
  const playlistsOn = usePlaylistsOn();
  const { data: playlistList } = usePlaylists();
  const mayPlay = useCan('player.use');
  const playerInstalled = useCapabilities().data?.player?.installed === true;
  const djHere = useDjViewAvailability() === 'ok';
  const ctx: GrammarContext = useMemo(() => ({ playlists: playlistsOn, player: mayPlay && playerInstalled, dj: djHere && mayPlay && playerInstalled }), [playlistsOn, mayPlay, playerInstalled, djHere]);
  const [input, setInput] = useState<SearchInput>(EMPTY_INPUT);
  // a liked album, artist or song carries a small heart
  const likes = useLikeSets();
  const likedRow = (row: Row) => (row.type === 'album' ? likes.albums.has(row.id)
    : row.type === 'track' ? likes.songs.has(row.id)
      : row.type === 'artist' ? !!row.id && likes.artists.has(row.id) : false);
  const q = input.text;
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

  const suggested = suggestions(input, ctx);
  const kind = apiKind(input.scope);
  // a kind the server does not search (playlists) asks it nothing
  const asks = suggested === null && input.scope !== 'playlist';
  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ['search', libraryId, debounced, kind],
    queryFn: () =>
      api.get<SearchResult>(`/libraries/${libraryId}/search?q=${encodeURIComponent(debounced)}${kind ? `&kind=${kind}` : ''}`),
    enabled: !!libraryId && asks && debounced.trim().length >= 2,
  });

  const words = q.trim();
  // the page's own list ("In albums"): not with an action, nor a chip of another kind
  const pageScoped = !!scope && !input.act && (!input.scope || input.scope === scope.kind);
  const rows: Row[] = useMemo(
    () => suggested ?? searchRows(asks ? data : undefined, words, q === debounced, pageScoped, { kinds: shownKinds(input), playlists: playlistList }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(suggested), data, q, debounced, pageScoped, input.act, input.scope, words, playlistList, asks],
  );

  useEffect(() => setSelected(0), [rows.length, debounced, input.act, input.scope]);

  // Scroll selected row into view
  useEffect(() => {
    if (!resultsRef.current || rows.length === 0) return;
    const selectedElement = resultsRef.current.querySelector(
      `#search-result-${selected}`
    ) as HTMLElement | null;
    selectedElement?.scrollIntoView({ block: 'nearest' });
  }, [selected, rows.length]);

  const type = (text: string) => setInput((prev) => absorb({ ...prev, text }, ctx));
  const accept = (s: Suggestion) => {
    if (s.type === 'suggest') type(s.insert);
    else type(s.primary);
    inputRef.current?.focus();
  };

  const open = (row: Row) => {
    if (row.type === 'suggest') { accept(row); return; }
    if (row.type === 'command') {
      onClose();
      void navigate({ to: '/dj' });
      return;
    }
    if (row.type === 'theme') {
      setThemePreference(row.target === 'auto' ? 'system' : row.target);
      onClose();
      return;
    }
    if (input.act && ACTABLE.has(row.type)) {
      const act = input.act;
      onClose();
      void runAct(act, row).catch(() => showToast({ message: act === 'queue' ? 'Not added. Try again.' : 'Not started. Try again.', tone: 'danger' }));
      return;
    }
    onClose();
    if (row.type === 'go') {
      void navigate({ to: GO_PATH[row.target] as never });
    } else if (row.type === 'scope') {
      scope?.onPick(words);
    } else if (row.type === 'artist' && row.id) {
      navigate({ to: '/artists/$artistId', params: { artistId: row.id } as never });
    } else if (row.type === 'artist') {
      // Tag-only artist (no linked identity yet): open their albums.
      navigate({ to: '/albums', search: { artist: row.primary } as never });
    } else if (row.type === 'label') {
      navigate({ to: '/albums', search: { label: [row.primary] } as never });
    } else if (row.type === 'playlist') {
      navigate({ to: '/playlists/$playlistId', params: { playlistId: row.id } as never });
    } else {
      const albumId = row.type === 'album' ? row.id : row.albumId;
      navigate({ to: '/albums/$albumId', params: { albumId } as never });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const current = rows[selected];
    if (e.key === 'Tab' && e.target === inputRef.current && !e.shiftKey && current && (current.type === 'suggest' || current.type === 'go' || current.type === 'theme')) {
      e.preventDefault();
      accept(current);
    } else if (e.key === 'Tab') {
      const focusable = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('input, button'));
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      focusable[(index + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
    }
    else if (e.key === 'Escape') onClose();
    else if (e.target !== inputRef.current) return;
    else if (e.key === 'Backspace' && q === '' && (input.act || input.scope)) {
      e.preventDefault();
      setInput(dropChip(input));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.max(0, Math.min(s + 1, rows.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter' && current) {
      // focus goes back to the header's search key as this closes: the
      // Enter must not go on to press it and open the search again
      e.preventDefault();
      open(current);
    }
  };

  const sections: { label: string; rows: { row: Row; index: number }[] }[] = useMemo(() => {
    const indexed = rows.map((row, index) => ({ row, index }));
    if (suggested) return [{ label: '', rows: indexed }];
    return [
      { label: scope?.label ?? '', rows: indexed.filter((r) => r.row.type === 'scope') },
      ...(['album', 'artist', 'track', 'playlist', 'label'] as const).map((t) => ({ label: SECTION[t]!, rows: indexed.filter((r) => r.row.type === t) })),
    ].filter((s) => s.rows.length > 0);
  }, [rows, scope, suggested]);

  const chips = [input.act && actDef(input.act).chip, input.scope && scopeDef(input.scope).chip].filter((c): c is string => !!c);
  const shouldShowResults = !!suggested || (pageScoped && words.length > 0) || (words.length >= 2 && (rows.length > 0 || !isFetching));
  const hasSearched = !suggested && q === debounced && words.length >= 2;
  const found = rows.some((r) => r.type !== 'scope');
  const blank = q === '' && chips.length === 0;
  const placeholder = input.scope ? `${scopeDef(input.scope).chip}s` : input.act ? 'Album, song, playlist' : 'Search albums, artists, songs…';
  const what = input.scope ? `${scopeDef(input.scope).word}s` : 'albums, artists, and songs';

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Search your library" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className={styles.inputContainer}>
          <svg className={styles.searchIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          {chips.length > 0 && (
            <span className={styles.chips} data-testid="search-chips">
              {chips.map((c) => <span key={c} className={styles.token}>{c}</span>)}
            </span>
          )}
          <input
            ref={inputRef}
            aria-label={`${input.act ? `${actDef(input.act).chip}: ` : ''}Search ${what}`}
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="search-results"
            aria-autocomplete="list"
            aria-activedescendant={rows[selected] ? `search-result-${selected}` : undefined}
            className={chips.length ? styles.inputChipped : styles.input}
            placeholder={placeholder}
            value={q}
            onChange={(e) => type(e.target.value)}
          />
          <div className={styles.escHint}>esc</div>
          {isFetching && <div className={styles.loadingBar} role="status" aria-label="Searching" />}
        </div>
        {isError && asks && (
          <div className={styles.error} role="alert">
            Search is unavailable. <Button variant="quiet" size="sm" onClick={() => void refetch()}>Retry</Button>
          </div>
        )}
        {shouldShowResults && (
          <div className={styles.results} id="search-results" role="listbox" aria-label="Search results" ref={resultsRef}>
            {sections.map((s) => (
              <div key={s.label || 'suggest'}>
                {s.label && <div className={styles.sectionLabel}>{s.label}</div>}
                {s.rows.map(({ row, index }) => {
                  const hint = suggested ? (row.type === 'suggest' ? 'tab' : '↵') : input.act && ACTABLE.has(row.type) ? '↵' : null;
                  const option = (
                    <div
                      key={index}
                      id={`search-result-${index}`}
                      role="option"
                      aria-selected={index === selected}
                      className={`${index === selected ? styles.rowSelected : styles.row} ${suggested ? styles.suggestRow : ''}`}
                      onMouseEnter={() => setSelected(index)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => open(row)}
                    >
                      <span className={styles.primary}>
                        {row.primary}
                        {likedRow(row) && <span className={styles.liked} title="Liked"><HeartIcon filled /><span className={styles.srOnly}>, liked</span></span>}
                      </span>
                      {row.secondary && <span className={styles.secondary}>{row.secondary}</span>}
                      {hint && index === selected && <kbd className={styles.rowKey} aria-hidden="true">{hint}</kbd>}
                    </div>
                  );
                  if (row.type !== 'track' || input.act) return option;
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
            {hasSearched && !found && !isFetching && !(isError && asks) && (
              <div className={styles.noResults}>No results for "{debounced}"</div>
            )}
          </div>
        )}
        {blank && (
          <div className={styles.hints} aria-hidden="true">
            <span><kbd>@</kbd>Kind</span>
            <span><kbd>/</kbd>Command</span>
            <span><kbd>↑</kbd><kbd>↓</kbd></span>
            <span><kbd>↵</kbd></span>
          </div>
        )}
      </div>
    </div>
  );
}
