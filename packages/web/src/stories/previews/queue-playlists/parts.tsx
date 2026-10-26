/**
 * The pieces both directions share: covers and mosaics, track rows, the
 * queue list, the track ⋮ (desktop glass list and phone drawer), the mini
 * bars, the full Now Playing screen, the playlist page and grid. Built on the
 * real primitives (EmbossIconButton, Button, CoverArt, Sheet, Tabs,
 * SegmentedControl) and the real stylesheets of the album drawer, the menu
 * and the player bar, so the previews read as the app. Preview only.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Button, CoverArt, EmbossIconButton, KebabIcon, PauseIcon, PlayIcon, PreviousIcon, NextIcon, ShuffleIcon, QueueIcon, CloseIcon, DiscIcon, PersonIcon, SegmentedControl } from '../../../components/ui';
import { Sheet } from '../../../components/ui/Sheet';
import menu from '../../../components/ui/Menu.module.css';
import drawer from '../../../pages/AlbumMenu.module.css';
import bar from '../../../components/PlayerBar.module.css';
import { AddQueueIcon, ChevronDownBigIcon, ChevronRightIcon, ExportIcon, GripIcon, ImportIcon, PlayNextIcon, PlaylistIcon, PlusIcon, RenameIcon, RepeatIcon, SaveIcon, TrashIcon } from './icons';
import { albumById, clock, longDuration, mosaicOf, playlists, queue, totalSec, trackById, tracksOf, type Album, type Playlist, type Track } from './fixtures';
import s from './parts.module.css';

const noop = () => undefined;

// ---- covers ----

export function Mosaic({ covers, className, title }: { covers: string[]; className?: string; title: string }) {
  if (covers.length < 4) return <span className={`${s.mosaic} ${s.single} ${className ?? ''}`} aria-hidden="true" title={title}><img src={covers[0]} alt="" /></span>;
  return (
    <span className={`${s.mosaic} ${className ?? ''}`} aria-hidden="true">
      {covers.map((c, i) => <img key={i} src={c} alt="" />)}
    </span>
  );
}

export const PlaylistCover = ({ p, className }: { p: Playlist; className?: string }) => <Mosaic covers={mosaicOf(p)} title={p.name} className={className} />;

// ---- track rows ----

export type Lead = 'no' | 'cover' | 'grip' | 'now';

export interface TrackRowProps {
  track: Track;
  lead: Lead;
  /** the album column (playlists, queue on a desktop) */
  album?: boolean;
  state?: 'played' | 'current' | 'next';
  /** the row's ⋮ is open (the row shows hovered) */
  open?: boolean;
  /** an Edit mode: a remove key in place of ⋮ */
  removable?: boolean;
  /** no ⋮ at all */
  bare?: boolean;
  /** shown as being dragged */
  lifted?: boolean;
  index?: number;
  /** what opens from the row (its ⋮ list, shown open) */
  children?: ReactNode;
}

export function TrackRow({ track, lead, album = false, state = 'next', open = false, removable = false, bare = false, lifted = false, index, children }: TrackRowProps) {
  const a = albumById(track.albumId);
  return (
    <li className={s.row} data-state={state} data-open={open || undefined} data-lifted={lifted || undefined} data-album={album || undefined}>
      {lead === 'grip' && <span className={s.grip} aria-hidden="true"><GripIcon /></span>}
      {lead === 'no' && <span className={s.no}>{state === 'current' ? <span className={s.nowMark} /> : index ?? track.no}</span>}
      {lead === 'now' && <span className={s.no}><span className={s.nowMark} /></span>}
      {(lead === 'cover' || lead === 'grip' || lead === 'now') && <CoverArt src={a.cover} title={a.title} compact className={s.thumb} />}
      <span className={s.names}>
        <span className={s.title} dir="auto">{track.title}</span>
        <span className={s.artist} dir="auto">{track.artist}</span>
      </span>
      {album && <span className={s.albumCol} dir="auto">{a.title}</span>}
      <span className={s.time}>{clock(track.sec)}</span>
      {!bare && (removable
        ? <EmbossIconButton label={`Remove ${track.title}`} className={s.rowKey}><CloseIcon /></EmbossIconButton>
        : <EmbossIconButton label={`More for ${track.title}`} className={s.rowKey} aria-expanded={open || undefined}><KebabIcon /></EmbossIconButton>)}
      {children}
    </li>
  );
}

// ---- the queue ----

export interface QueueListProps {
  tab: 'next' | 'history';
  /** a desktop panel shows the album column hidden; rows are compact */
  dense?: boolean;
  /** the row being dragged (index into queued) */
  lifted?: number;
  /** the "Save as playlist" field is open */
  naming?: boolean;
  /** Up next / History as tabs at the top */
  tabs?: boolean;
  onTab?: (t: 'next' | 'history') => void;
}

export function QueueList({ tab, lifted, naming = false, tabs = true }: QueueListProps) {
  return (
    <div className={s.queue}>
      {tabs && (
        <div className={s.queueTabs}>
          <SegmentedControl<'next' | 'history'> label="Queue" value={tab} onChange={noop} size="sm" options={[{ value: 'next', label: 'Up next' }, { value: 'history', label: 'History' }]} />
        </div>
      )}
      {tab === 'next' ? (
        <>
          <h4 className={s.groupHead}>Now playing</h4>
          <ol className={s.list}><TrackRow track={queue.current} lead="now" state="current" bare /></ol>
          <div className={s.groupRow}>
            <h4 className={s.groupHead}>Next in queue</h4>
            <button type="button" className={s.textKey}>Clear</button>
          </div>
          <ol className={s.list}>
            {queue.queued.map((t, i) => <TrackRow key={t.id} track={t} lead="grip" lifted={lifted === i} />)}
          </ol>
          <div className={s.groupRow}>
            <h4 className={s.groupHead}>Next from {queue.context.name}</h4>
          </div>
          <ol className={s.list}>
            {queue.context.tracks.map((t) => <TrackRow key={t.id} track={t} lead="grip" />)}
          </ol>
          <div className={s.queueFoot}>
            {naming ? (
              <form className={s.nameForm} onSubmit={(e) => e.preventDefault()}>
                <label className={s.srOnly} htmlFor="qp-name">Name</label>
                <input id="qp-name" className={s.nameField} defaultValue="Queue, 26 Oct" autoFocus />
                <Button size="sm" variant="primary">Save</Button>
                <Button size="sm" variant="quiet">Cancel</Button>
              </form>
            ) : (
              <Button size="sm" variant="secondary"><span className={s.btnIcon}><SaveIcon /></span>Save as playlist</Button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className={s.groupRow}>
            <h4 className={s.groupHead}>Played</h4>
            <button type="button" className={s.textKey}>Clear</button>
          </div>
          <ol className={s.list}>
            {[...queue.history].reverse().map((t) => <TrackRow key={t.id} track={t} lead="cover" state="played" />)}
            {[trackById('t17'), trackById('t13')].map((t) => <TrackRow key={`h${t.id}`} track={t} lead="cover" state="played" />)}
          </ol>
        </>
      )}
    </div>
  );
}

// ---- the track ⋮ ----

export interface MenuRow { key: string; label: string; icon?: ReactNode; hint?: string; sub?: boolean; separated?: boolean; danger?: boolean; checked?: boolean; cover?: ReactNode }

/** A glass list as Menu draws it, shown open at a fixed place (the previews cannot click). */
export function GlassList({ rows, style, heading, wide = false }: { rows: MenuRow[]; style: CSSProperties; heading?: string; wide?: boolean }) {
  return (
    <div className={`${menu.menu} ${s.glass} ${wide ? s.glassWide : ''}`} style={style} role="menu">
      {heading && <div className={menu.heading}>{heading}</div>}
      {rows.map((r) => (
        <button key={r.key} type="button" role="menuitem" className={[menu.item, s.glassItem, r.danger ? menu.danger : '', r.separated ? menu.separated : ''].join(' ')} data-active={r.sub || undefined}>
          {r.cover ?? (r.icon && <span className={s.glassIcon}>{r.icon}</span>)}
          <span className={s.glassText}>
            <span className={menu.itemLabel}>{r.label}</span>
            {r.hint && <span className={menu.itemHint}>{r.hint}</span>}
          </span>
          {r.sub && <span className={s.glassChevron}><ChevronRightIcon /></span>}
        </button>
      ))}
    </div>
  );
}

export const trackMenuRows = (submenu: boolean): MenuRow[] => [
  { key: 'next', label: 'Play next', icon: <PlayNextIcon /> },
  { key: 'queue', label: 'Add to queue', icon: <AddQueueIcon /> },
  { key: 'pl', label: submenu ? 'Add to playlist' : 'Add to playlist…', icon: <PlaylistIcon />, sub: submenu },
  { key: 'album', label: 'Go to album', icon: <DiscIcon />, separated: true },
  { key: 'artist', label: 'Go to artist', icon: <PersonIcon /> },
];

export const playlistSubRows = (): MenuRow[] => [
  { key: 'new', label: 'New playlist', icon: <PlusIcon /> },
  ...playlists.slice(0, 5).map((p, i) => ({ key: p.id, label: p.name, separated: i === 0, cover: <PlaylistCover p={p} className={s.glassCover} /> })),
];

/** The track drawer on a phone: the album drawer's summary, tiles and rows. */
export function TrackDrawer({ track, open = true }: { track: Track; open?: boolean }) {
  const a = albumById(track.albumId);
  return (
    <Sheet open={open} onOpenChange={noop} title={`${track.title}: more`}>
      <div className={drawer.sheet}>
        <div className={drawer.head}>
          <CoverArt src={a.cover} title={a.title} compact className={drawer.thumb} />
          <div className={drawer.headText}>
            <p className={drawer.headTitle}>{track.title}</p>
            <p className={drawer.headArtist}>{track.artist} · {a.title}</p>
          </div>
        </div>
        <ul className={drawer.tiles} data-count="3">
          <li><button type="button" className={drawer.tile}><span className={drawer.tileIcon}><PlayNextIcon /></span><span className={drawer.tileLabel}>Play next</span></button></li>
          <li><button type="button" className={drawer.tile}><span className={drawer.tileIcon}><AddQueueIcon /></span><span className={drawer.tileLabel}>Add to queue</span></button></li>
          <li><button type="button" className={drawer.tile}><span className={drawer.tileIcon}><PlaylistIcon /></span><span className={drawer.tileLabel}>Add to playlist</span></button></li>
        </ul>
        <ul className={drawer.rows}>
          <li><button type="button" className={drawer.row}><span className={drawer.rowIcon}><DiscIcon /></span><span className={drawer.rowText}><span className={drawer.rowLabel}>Go to album</span></span></button></li>
          <li><button type="button" className={drawer.row}><span className={drawer.rowIcon}><PersonIcon /></span><span className={drawer.rowText}><span className={drawer.rowLabel}>Go to artist</span></span></button></li>
        </ul>
      </div>
    </Sheet>
  );
}

/** A: the second step of the drawer, the person's playlists as a list. */
export function PlaylistListDrawer({ track, open = true }: { track: Track; open?: boolean }) {
  return (
    <Sheet open={open} onOpenChange={noop} title="Add to playlist">
      <div className={drawer.sheet}>
        <div className={s.drawerTitle}>
          <EmbossIconButton label="Back" className={s.drawerBack}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5.5 8.5 12l6.5 6.5" /></svg></EmbossIconButton>
          <span>Add to playlist</span>
          <span className={s.drawerSub}>{track.title}</span>
        </div>
        <ul className={drawer.rows}>
          <li><button type="button" className={drawer.row}><span className={s.listCoverNew}><PlusIcon /></span><span className={drawer.rowText}><span className={drawer.rowLabel}>New playlist</span></span></button></li>
          {playlists.map((p) => (
            <li key={p.id}>
              <button type="button" className={drawer.row}>
                <PlaylistCover p={p} className={s.listCover} />
                <span className={drawer.rowText}><span className={drawer.rowLabel}>{p.name}</span><span className={drawer.rowHint}>{p.trackIds.length} tracks</span></span>
                {p.trackIds.includes(track.id) && <span className={s.already}>Added</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}

/** B: the picker as a grid of covers (a drawer on a phone, a dialog on a desktop). */
export function PickerGrid({ track, columns }: { track: Track; columns: number }) {
  return (
    <div className={s.picker} style={{ '--cols': columns } as CSSProperties}>
      <button type="button" className={s.pickTile}>
        <span className={s.pickNew}><PlusIcon /></span>
        <span className={s.pickName}>New playlist</span>
      </button>
      {playlists.map((p) => (
        <button type="button" key={p.id} className={s.pickTile} data-has={p.trackIds.includes(track.id) || undefined}>
          <PlaylistCover p={p} className={s.pickCover} />
          <span className={s.pickName}>{p.name}</span>
          <span className={s.pickMeta}>{p.trackIds.includes(track.id) ? 'Added' : `${p.trackIds.length} tracks`}</span>
        </button>
      ))}
    </div>
  );
}

export function PickerDrawer({ track }: { track: Track }) {
  return (
    <Sheet open onOpenChange={noop} title="Add to playlist">
      <div className={drawer.sheet}>
        <div className={s.drawerTitle}><span>Add to playlist</span><span className={s.drawerSub}>{track.title}</span></div>
        <PickerGrid track={track} columns={3} />
      </div>
    </Sheet>
  );
}

export function PickerDialog({ track }: { track: Track }) {
  return (
    <div className={s.scrim}>
      <div className={s.dialog} role="dialog" aria-label="Add to playlist">
        <div className={s.dialogHead}>
          <div className={s.drawerTitle}><span>Add to playlist</span><span className={s.drawerSub}>{track.title} · {track.artist}</span></div>
          <EmbossIconButton label="Close"><CloseIcon /></EmbossIconButton>
        </div>
        <PickerGrid track={track} columns={4} />
      </div>
    </div>
  );
}

/** A on a phone: the queue as a drawer over Now Playing. */
export function QueueDrawer({ tab = 'next' }: { tab?: 'next' | 'history' }) {
  return (
    <Sheet open onOpenChange={noop} title="Queue">
      <div className={s.drawerQueue}>
        <div className={s.drawerTitle}><span>Queue</span></div>
        <QueueList tab={tab} />
      </div>
    </Sheet>
  );
}

// ---- mini bars (phone) ----

/** A (Spotify, Apple Music): a floating card, the progress a hairline along its foot. */
export function MiniBarA() {
  const t = queue.current;
  const a = albumById(t.albumId);
  const fill = (queue.position / t.sec) * 100;
  return (
    <div className={s.miniDockA}>
      <button type="button" className={s.miniA} aria-label={`Now playing: ${t.title}. Open the player`}>
        <CoverArt src={a.cover} title={a.title} compact className={s.miniCover} />
        <span className={s.miniNames}>
          <span className={s.miniTitle}>{t.title}</span>
          <span className={s.miniArtist}>{t.artist}</span>
        </span>
        <span className={s.miniProgress} style={{ '--fill': `${fill}%` } as CSSProperties} aria-hidden="true" />
      </button>
      <EmbossIconButton label="Pause" className={s.miniKey}><PauseIcon /></EmbossIconButton>
    </div>
  );
}

/** B (Qobuz): an edge-to-edge strip, the progress a hairline along its top, play and next. */
export function MiniBarB() {
  const t = queue.current;
  const a = albumById(t.albumId);
  const fill = (queue.position / t.sec) * 100;
  return (
    <div className={s.miniDockB}>
      <span className={s.miniProgressTop} style={{ '--fill': `${fill}%` } as CSSProperties} aria-hidden="true" />
      <button type="button" className={s.miniB} aria-label={`Now playing: ${t.title}. Open the player`}>
        <CoverArt src={a.cover} title={a.title} compact className={s.miniCover} />
        <span className={s.miniNames}>
          <span className={s.miniTitle}>{t.title}</span>
          <span className={s.miniArtist}>{t.artist} · {a.title}</span>
        </span>
      </button>
      <EmbossIconButton label="Pause" className={s.miniKey}><PauseIcon /></EmbossIconButton>
      <EmbossIconButton label="Next track" className={s.miniKey}><NextIcon /></EmbossIconButton>
    </div>
  );
}

// ---- now playing ----

export function Scrubber({ big = false }: { big?: boolean }) {
  const t = queue.current;
  const fill = (queue.position / t.sec) * 100;
  return (
    <div className={`${s.scrub} ${big ? s.scrubBig : ''}`}>
      <input type="range" className={bar.range} style={{ '--fill': `${fill}%` } as CSSProperties} min={0} max={t.sec} value={queue.position} onChange={noop} aria-label="Seek" />
      <span className={s.scrubTimes}><span>{clock(queue.position)}</span><span>-{clock(t.sec - queue.position)}</span></span>
    </div>
  );
}

export function Transport() {
  return (
    <div className={s.transport} role="group" aria-label="Playback">
      <EmbossIconButton label="Shuffle" aria-pressed="false"><ShuffleIcon /></EmbossIconButton>
      <EmbossIconButton label="Previous track" className={s.tKey}><PreviousIcon /></EmbossIconButton>
      <EmbossIconButton label="Pause" className={s.tPlay}><PauseIcon /></EmbossIconButton>
      <EmbossIconButton label="Next track" className={s.tKey}><NextIcon /></EmbossIconButton>
      <EmbossIconButton label="Repeat" aria-pressed="false"><RepeatIcon /></EmbossIconButton>
    </div>
  );
}

function NowNames({ center = false }: { center?: boolean }) {
  const t = queue.current;
  const a = albumById(t.albumId);
  return (
    <div className={`${s.npNames} ${center ? s.npCenter : ''}`}>
      <span className={s.npTitle}>{t.title}</span>
      <span className={s.npSub}><a href="#" className={s.link}>{t.artist}</a> · <a href="#" className={s.link}>{a.title}</a></span>
    </div>
  );
}

/** The full Now Playing screen on a phone. A: the queue key opens a drawer. B: Playing | Queue inside the screen. */
export function NowPlayingPhone({ variant, segment = 'playing', queueTab = 'next' }: { variant: 'A' | 'B'; segment?: 'playing' | 'queue'; queueTab?: 'next' | 'history' }) {
  const a = albumById(queue.current.albumId);
  return (
    <div className={s.np} role="dialog" aria-label="Now playing">
      <div className={s.npBg} style={{ backgroundImage: `url("${a.cover}")` }} aria-hidden="true" />
      <header className={s.npHead}>
        <EmbossIconButton label="Close the player" place="header"><ChevronDownBigIcon /></EmbossIconButton>
        {variant === 'B' ? (
          <div className={s.npSeg}>
            <SegmentedControl<'playing' | 'queue'> label="Now playing view" value={segment} onChange={noop} size="sm" options={[{ value: 'playing', label: 'Playing' }, { value: 'queue', label: 'Queue' }]} />
          </div>
        ) : (
          <span className={s.npFrom}><span className={s.npFromLabel}>Playing from album</span><span className={s.npFromValue}>{a.title}</span></span>
        )}
        <EmbossIconButton label="More for this track" place="header"><KebabIcon /></EmbossIconButton>
      </header>
      {segment === 'playing' ? (
        <div className={s.npBody}>
          <CoverArt src={a.cover} title={a.title} className={s.npCover} />
          <NowNames />
          <Scrubber big />
          <Transport />
          {variant === 'A' ? (
            <div className={s.npFoot}>
              <span className={s.npDevice}>This device</span>
              <EmbossIconButton label="Queue"><QueueIcon /></EmbossIconButton>
            </div>
          ) : (
            <button type="button" className={s.peek}>
              <span className={s.peekLabel}>Up next</span>
              <span className={s.peekValue}>{queue.queued[0]!.title} · {queue.queued[0]!.artist}</span>
              <ChevronRightIcon />
            </button>
          )}
        </div>
      ) : (
        <div className={s.npQueue}>
          <div className={s.npMini}>
            <CoverArt src={a.cover} title={a.title} compact className={s.npMiniCover} />
            <NowNames />
            <EmbossIconButton label="Pause"><PauseIcon /></EmbossIconButton>
          </div>
          <QueueList tab={queueTab} />
        </div>
      )}
    </div>
  );
}

/** B on a desktop: the full Now Playing view over the content area, the queue beside the cover. */
export function NowPlayingDesktop({ tab = 'next' }: { tab?: 'next' | 'history' }) {
  const a = albumById(queue.current.albumId);
  return (
    <div className={s.npd}>
      <div className={s.npBg} style={{ backgroundImage: `url("${a.cover}")` }} aria-hidden="true" />
      <header className={s.npdHead}>
        <EmbossIconButton label="Close Now playing" place="header"><ChevronDownBigIcon /></EmbossIconButton>
        <span className={s.npFrom}><span className={s.npFromLabel}>Playing from album</span><span className={s.npFromValue}>{a.title}</span></span>
        <span style={{ width: 44 }} />
      </header>
      <div className={s.npdBody}>
        <div className={s.npdLeft}>
          <CoverArt src={a.cover} title={a.title} className={s.npdCover} />
          <NowNames center />
        </div>
        <div className={s.npdRight}>
          <h3 className={s.panelTitle}>Queue</h3>
          <QueueList tab={tab} />
        </div>
      </div>
    </div>
  );
}

// ---- A: the right-hand panel ----

export function SidePanel({ mode, tab = 'next', naming = false }: { mode: 'queue' | 'now'; tab?: 'next' | 'history'; naming?: boolean }) {
  const a = albumById(queue.current.albumId);
  return (
    <aside className={s.side} aria-label={mode === 'queue' ? 'Queue' : 'Now playing'}>
      <header className={s.sideHead}>
        <h3 className={s.panelTitle}>{mode === 'queue' ? 'Queue' : a.title}</h3>
        <EmbossIconButton label="Close the panel" place="header"><CloseIcon /></EmbossIconButton>
      </header>
      {mode === 'queue' ? <QueueList tab={tab} naming={naming} /> : (
        <div className={s.sideNow}>
          <CoverArt src={a.cover} title={a.title} className={s.sideCover} />
          <NowNames />
          <div className={s.groupRow}>
            <h4 className={s.groupHead}>Next in queue</h4>
            <button type="button" className={s.textKey}>Open queue</button>
          </div>
          <ol className={s.list}><TrackRow track={queue.queued[0]!} lead="cover" /></ol>
          <div className={s.groupRow}><h4 className={s.groupHead}>Credits</h4></div>
          <dl className={s.credits}>
            <dt>Trumpet, vocals</dt><dd>Chet Baker</dd>
            <dt>Piano</dt><dd>Bill Evans</dd>
            <dt>Flute</dt><dd>Herbie Mann</dd>
            <dt>Producer</dt><dd>Orrin Keepnews</dd>
          </dl>
        </div>
      )}
    </aside>
  );
}

// ---- A: the sidebar's Playlists section ----

export function SidebarPlaylists({ activeId, menuOpen = false }: { activeId?: string; menuOpen?: boolean }) {
  return (
    <section className={s.sideList} aria-label="Playlists">
      <div className={s.sideListHead}>
        <span className={s.sideListTitle}>Playlists</span>
        <EmbossIconButton label="New playlist or import" place="header" className={s.sideListKey} aria-expanded={menuOpen}><PlusIcon /></EmbossIconButton>
      </div>
      <ul className={s.sideListItems}>
        {playlists.map((p) => (
          <li key={p.id}>
            <a href="#" className={s.sideItem} data-active={p.id === activeId || undefined} onClick={(e) => e.preventDefault()}>
              <PlaylistCover p={p} className={s.sideItemCover} />
              <span className={s.sideItemName}>{p.name}</span>
              {p.id === 'late' && <span className={s.sideItemNow} aria-label="Playing"><span className={s.nowMark} /></span>}
            </a>
          </li>
        ))}
      </ul>
      {menuOpen && (
        <GlassList style={{ position: 'absolute', top: 38, left: 0, minWidth: 0, width: 208 }} rows={[
          { key: 'new', label: 'New playlist', icon: <PlusIcon /> },
          { key: 'import', label: 'Import…', icon: <ImportIcon /> },
        ]} />
      )}
    </section>
  );
}

// ---- pages ----

export function AlbumPage({ album, openTrack, menu }: { album: Album; openTrack?: string; menu?: ReactNode }) {
  const list = albumTracks(album.id);
  return (
    <div className={s.page}>
      <div className={s.hero}>
        <CoverArt src={album.cover} title={album.title} className={s.heroCover} />
        <div className={s.heroText}>
          <span className={s.kicker}>Album · {album.year}</span>
          <h1 className={s.heroTitle}>{album.title}</h1>
          <span className={s.heroSub}><a href="#" className={s.link}>{album.artist}</a></span>
          <div className={s.actions}>
            <EmbossIconButton label="Shuffle"><ShuffleIcon /></EmbossIconButton>
            <EmbossIconButton label="Play" className={s.bigPlay}><PlayIcon /></EmbossIconButton>
            <EmbossIconButton label="More for this album"><KebabIcon /></EmbossIconButton>
          </div>
        </div>
      </div>
      <ol className={s.list}>
        {list.map((t) => <TrackRow key={t.id} track={t} lead="no" open={t.id === openTrack} state={t.id === queue.current.id ? 'current' : 'next'}>{t.id === openTrack ? menu : null}</TrackRow>)}
      </ol>
    </div>
  );
}

const albumTracks = (albumId: string): Track[] => tracksOf(albumId);

export function PlaylistHeader({ p, menuOpen = false, editing = false, editKey = false }: { p: Playlist; menuOpen?: boolean; editing?: boolean; editKey?: boolean }) {
  return (
    <div className={s.hero}>
      <PlaylistCover p={p} className={s.heroCover} />
      <div className={s.heroText}>
        <span className={s.kicker}>Playlist</span>
        <h1 className={s.heroTitle}>{p.name}</h1>
        <span className={s.heroSub}>{p.trackIds.length} tracks · {longDuration(totalSec(p.trackIds))}</span>
        <div className={s.actions}>
          {editing ? (
            <Button variant="primary" size="sm">Done</Button>
          ) : (
            <>
              <EmbossIconButton label="Shuffle"><ShuffleIcon /></EmbossIconButton>
              <EmbossIconButton label="Play" className={s.bigPlay}><PlayIcon /></EmbossIconButton>
              {editKey && <EmbossIconButton label="Edit"><RenameIcon /></EmbossIconButton>}
              <span className={s.anchor}>
                <EmbossIconButton label="More for this playlist" aria-expanded={menuOpen}><KebabIcon /></EmbossIconButton>
                {menuOpen && (
                  <GlassList style={{ position: 'absolute', top: 48, left: 0 }} rows={[
                    { key: 'queue', label: 'Add to queue', icon: <AddQueueIcon /> },
                    { key: 'rename', label: 'Rename', icon: <RenameIcon /> },
                    { key: 'export', label: 'Export', icon: <ExportIcon /> },
                    { key: 'delete', label: 'Delete', icon: <TrashIcon />, danger: true, separated: true },
                  ]} />
                )}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function PlaylistTracks({ p, lead, editing = false, lifted, openTrack, album = true }: { p: Playlist; lead: Lead; editing?: boolean; lifted?: number; openTrack?: string; album?: boolean }) {
  return (
    <ol className={s.list}>
      {p.trackIds.map((id, i) => (
        <TrackRow key={id} track={trackById(id)} lead={editing ? 'grip' : lead} album={album} index={i + 1} removable={editing} lifted={lifted === i} open={openTrack === id} state={id === queue.current.id ? 'current' : 'next'} />
      ))}
    </ol>
  );
}

export function PlaylistPage({ p, lead, menuOpen, editing, editKey, lifted, album = true }: { p: Playlist; lead: Lead; menuOpen?: boolean; editing?: boolean; editKey?: boolean; lifted?: number; album?: boolean }) {
  return (
    <div className={s.page}>
      <PlaylistHeader p={p} menuOpen={menuOpen} editing={editing} editKey={editKey} />
      <PlaylistTracks p={p} lead={lead} editing={editing} lifted={lifted} album={album} />
    </div>
  );
}

export function PlaylistsGrid({ importOpen = false }: { importOpen?: boolean }) {
  return (
    <div className={s.page}>
      <div className={s.gridHead}>
        <h1 className={s.pageTitle} data-page-title="">Playlists</h1>
        <div className={s.gridTools}>
          <span className={s.anchor}>
            <EmbossIconButton label="Import a playlist" aria-expanded={importOpen}><ImportIcon /></EmbossIconButton>
            {importOpen && <GlassList style={{ position: 'absolute', top: 48, right: 0 }} rows={[{ key: 'file', label: 'Import from a file…', icon: <ImportIcon /> }]} />}
          </span>
          <EmbossIconButton label="New playlist"><PlusIcon /></EmbossIconButton>
        </div>
      </div>
      <ul className={s.grid}>
        {playlists.map((p) => (
          <li key={p.id}>
            <a href="#" className={s.tile} onClick={(e) => e.preventDefault()}>
              <PlaylistCover p={p} className={s.tileCover} />
              <span className={s.tileName}>{p.name}</span>
              <span className={s.tileMeta}>{p.trackIds.length} tracks</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export { ExportIcon, ImportIcon };
