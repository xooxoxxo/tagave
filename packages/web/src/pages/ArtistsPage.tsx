/**
 * Artists browser: a grid of artist cards (cover mosaic or initials) or a
 * compact list, with search as you type, three sorts, an A–Z jump bar, and a
 * virtualized, infinitely paged body that stays fast over tens of thousands
 * of artists. Ordering and grouping come from the server (see api
 * lib/artistList.ts); names are shown through artistLabel so junk tags never
 * render as an empty box.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ARTIST_GROUP_ORDER, artistGroupLabel, artistLabel, cleanArtistName } from '@liner/shared';
import { useCurrentLibrary } from '../hooks';
import { useArtistsInfinite, type ArtistListItem, type ArtistSort } from '../hooks/useArtists';
import { Button, EmptyState, SearchField, Select } from '../components/ui';
import { ArtistArtwork, IdentityMark } from '../components/ArtistArtwork';
import {
  ARTIST_SORT_OPTIONS, artistMeta, readArtistsView, writeArtistsView, yearsLabel, type ArtistsView,
} from './artistsView';
import styles from './ArtistsPage.module.css';

const MIN_CARD = 150;
const MIN_CARD_NARROW = 132;
const GRID_GAP = 18;
const GRID_GAP_NARROW = 12;
/** name + meta lines under the picture */
const CARD_INFO = 54;
const LIST_ROW = 52;
/** matches .scroller padding in ArtistsPage.module.css */
const SCROLL_PAD = 4;

const jumpLabel = (key: string) => (key === 'other' ? 'Other' : key === '0-9' ? '0–9' : key);

function ArtistLink({ artist, className, children }: { artist: ArtistListItem; className?: string | undefined; children: React.ReactNode }) {
  const label = artistLabel(artist.name);
  const raw = cleanArtistName(artist.name);
  // the full name as tagged when the label had to replace it
  const title = raw && raw !== label ? raw : undefined;
  return artist.id !== null && artist.resolved
    ? <Link className={className} to="/artists/$artistId" params={{ artistId: artist.id }} title={title}>{children}</Link>
    : <Link className={className} to="/albums" search={{ artist: artist.name } as never} title={title}>{children}</Link>;
}

export function ArtistsPage() {
  const { libraryId } = useCurrentLibrary();
  const [view, setViewState] = useState<ArtistsView>(readArtistsView);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ArtistSort>('name');
  const [group, setGroup] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const setView = (next: ArtistsView) => { setViewState(next); writeArtistsView(next); };

  const { data, isLoading, isFetching, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useArtistsInfinite(libraryId, { search, sort, group });
  const items = data?.pages.flatMap((p) => p.items) ?? [];
  const first = data?.pages[0];
  const total = first?.total ?? items.length;
  const groupCounts = new Map((first?.groups ?? []).map((g) => [g.key, g.count]));
  const allCount = [...groupCounts.values()].reduce((a, b) => a + b, 0);

  /* ---- virtualization (same shape as the albums grid) ---- */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [width, setWidth] = useState(0);
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    scrollRef.current = el;
    if (!el) return;
    // the scroller pads its content so focus rings are not clipped
    const measure = () => setWidth(Math.max(0, el.clientWidth - 2 * SCROLL_PAD));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    observerRef.current = ro;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const narrow = width > 0 && width < 600;
  const gap = narrow ? GRID_GAP_NARROW : GRID_GAP;
  const minCard = narrow ? MIN_CARD_NARROW : MIN_CARD;
  const cols = Math.max(1, Math.floor((width + gap) / (minCard + gap))) || 1;
  const cardWidth = width > 0 ? Math.floor((width - (cols - 1) * gap) / cols) : MIN_CARD;
  const rowHeight = view === 'list' ? LIST_ROW : cardWidth + CARD_INFO + gap;
  const rowCount = view === 'list' ? items.length : Math.ceil(items.length / cols);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: view === 'list' ? 12 : 3,
  });
  const virtualRows = virtualizer.getVirtualItems();
  useEffect(() => { virtualizer.measure(); }, [rowHeight, virtualizer]);

  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (!last || !hasNextPage || isFetchingNextPage) return;
    if (last.index >= rowCount - 3) void fetchNextPage();
  }, [virtualRows, hasNextPage, isFetchingNextPage, rowCount, fetchNextPage]);

  // a new search, sort or letter starts at the top
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [search, sort, group, view]);

  const onJumpKey = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
      : Math.min(buttons.length - 1, Math.max(0, at + (e.key === 'ArrowRight' ? 1 : -1)));
    e.preventDefault();
    buttons[next]?.focus();
  };

  const countText =!first ? '' : `${total.toLocaleString()} ${total === 1 ? 'artist' : 'artists'}`;
  const showEmpty = !!first && items.length === 0;

  return (
    <div className={styles.container} data-virtual-page>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Artists</h1>
          <span className={styles.count} aria-live="polite">{countText}{isFetching && !isFetchingNextPage && first ? <span className={styles.updating}> · updating</span> : null}</span>
        </div>
        <div className={styles.toolbar}>
          <SearchField
            dense
            className={styles.search}
            label="Search artists"
            placeholder="Search artists"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Select dense className={styles.sort} aria-label="Sort artists" value={sort} onChange={(e) => setSort(e.target.value as ArtistSort)}>
            {ARTIST_SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
          <div className={styles.viewToggle} role="group" aria-label="View mode">
            <Button size="sm" variant={view === 'grid' ? 'secondary' : 'quiet'} aria-pressed={view === 'grid'} onClick={() => setView('grid')}>Grid</Button>
            <Button size="sm" variant={view === 'list' ? 'secondary' : 'quiet'} aria-pressed={view === 'list'} onClick={() => setView('list')}>List</Button>
          </div>
        </div>
        {/* One tab stop: arrow keys, Home and End move between letters. */}
        <nav className={styles.jumpBar} aria-label="Filter by first letter" onKeyDown={onJumpKey}>
          <button type="button" className={styles.jump} aria-pressed={group === null} tabIndex={group === null ? 0 : -1} onClick={() => setGroup(null)}
            title={first ? `All ${allCount.toLocaleString()} artists` : 'All artists'}>All</button>
          {ARTIST_GROUP_ORDER.map((key) => {
            const count = groupCounts.get(key) ?? 0;
            const active = group === key;
            return <button
              key={key}
              type="button"
              className={styles.jump}
              aria-pressed={active}
              tabIndex={active ? 0 : -1}
              aria-label={`${artistGroupLabel(key)}, ${count.toLocaleString()} ${count === 1 ? 'artist' : 'artists'}`}
              title={`${artistGroupLabel(key)}: ${count.toLocaleString()}`}
              disabled={!!first && count === 0 && !active}
              onClick={() => setGroup(active ? null : key)}
            >{jumpLabel(key)}</button>;
          })}
        </nav>
      </header>

      {isLoading && <div className={styles.status} role="status">Loading artists…</div>}
      {error && <div className={styles.error} role="alert">Couldn’t load artists. <Button variant="secondary" size="sm" onClick={() => void refetch()}>Try again</Button></div>}
      {showEmpty && <EmptyState
        title={search || group ? 'No matching artists' : 'No artists in your library yet'}
        text={search || group ? 'Try another name or letter, or clear the search.' : 'Scan a music folder to build your artist library.'}
      />}
      {showEmpty && (search || group) && <p className={styles.clear}>
        <Button variant="secondary" size="sm" onClick={() => { setQ(''); setSearch(''); setGroup(null); }}>Show all artists</Button>
      </p>}

      {view === 'list' && items.length > 0 && <div className={styles.listHead} aria-hidden="true">
        <span />
        <span>Name</span>
        <span className={styles.num}>Albums</span>
        <span className={styles.num}>Tracks</span>
        <span>Years</span>
      </div>}

      <div className={view === 'list' ? styles.scrollerList : styles.scroller} ref={attachScroller}
        role={items.length ? 'list' : undefined} aria-label={items.length ? 'Artists' : undefined}>
        {items.length > 0 && width > 0 && (
          <div className={styles.canvas} style={{ height: virtualizer.getTotalSize() }}>
            {virtualRows.map((row) => {
              const style: React.CSSProperties = {
                position: 'absolute', top: 0, left: 0, width: '100%',
                transform: `translateY(${row.start}px)`, height: rowHeight,
              };
              if (view === 'list') {
                const artist = items[row.index];
                if (!artist) return null;
                const years = yearsLabel(artist.yearFrom, artist.yearTo);
                return <div key={`${artist.id ?? artist.name}`} role="listitem" style={style}>
                  <ArtistLink artist={artist} className={styles.row}>
                    <ArtistArtwork name={artist.name} coverAlbumIds={artist.coverAlbumIds} compact />
                    <span className={styles.rowName}>
                      <span className={styles.nameText}>{artistLabel(artist.name)}</span>
                      <IdentityMark resolved={artist.resolved} />
                    </span>
                    <span className={styles.num}>{artist.albumCount.toLocaleString()}</span>
                    <span className={`${styles.num} ${styles.secondary}`}>{artist.trackCount.toLocaleString()}</span>
                    <span className={styles.secondary}>{years ?? '–'}</span>
                  </ArtistLink>
                </div>;
              }
              const rowItems = items.slice(row.index * cols, row.index * cols + cols);
              return <div key={row.key} className={styles.gridRow} style={{ ...style, gap }}>
                {rowItems.map((artist) => (
                  <div key={`${artist.id ?? artist.name}`} role="listitem" style={{ width: cardWidth }}>
                    <ArtistLink artist={artist} className={styles.card}>
                      <ArtistArtwork name={artist.name} coverAlbumIds={artist.coverAlbumIds} />
                      <span className={styles.cardName}>
                        <span className={styles.nameText}>{artistLabel(artist.name)}</span>
                        <IdentityMark resolved={artist.resolved} />
                      </span>
                      <span className={styles.cardMeta}>{artistMeta(artist)}</span>
                    </ArtistLink>
                  </div>
                ))}
              </div>;
            })}
          </div>
        )}
        {isFetchingNextPage && <div className={styles.more} role="status">Loading more artists…</div>}
      </div>
    </div>
  );
}
