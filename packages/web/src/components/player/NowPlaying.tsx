/**
 * Now Playing (direction B, Qobuz):
 *
 *   NowPlayingView    a desktop's full view over the page, opened from the
 *                     player bar: the cover, the title, artist and album as
 *                     links, a few credits, and the queue (Up next | History)
 *                     beside them. The bar stays under it.
 *   NowPlayingScreen  a phone's full screen, opened from the mini bar:
 *                     Playing | Queue at the top; Playing has the cover, the
 *                     names, the seek bar, the keys and "Up next".
 *   MiniPlayer        a phone's bar: the cover, the title and artist on two
 *                     full lines, play / pause and next; the progress is a
 *                     hairline along its top. Pressing it opens the screen.
 *
 * All three are driven by props (stories, tests); PlayerBar connects them.
 * Colours come from the tokens; with Adaptive colours on they are the
 * playing cover's (styles/adaptive.css). The blurred cover behind shows as
 * strongly as its own darkest and lightest pixel let the text still read,
 * adaptive colours on or off (adaptive/wash.ts).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { PlayHistoryEntry, QueueContext } from '@tagave/shared';
import { CoverArt, EmbossIconButton, ChevronDownIcon, NextIcon, PauseIcon, PlayIcon, PreviousIcon, SegmentedControl, ChevronRightIcon } from '../ui';
import { clock } from '../../player/logic';
import type { PlayerStatus, QueueEntry } from '../../player/engine';
import { AlbumLink, ArtistLinks, linkedArtists, lineReset } from '../NowPlayingLinks';
import { QueuePanel, type QueueTab } from './QueuePanel';
import { useWashOpacity } from '../../adaptive/wash';
import bar from '../PlayerBar.module.css';
import styles from './NowPlaying.module.css';

export interface NowPlayingQueueProps {
  tracks: readonly QueueEntry[];
  index: number;
  context: QueueContext | null;
  onPlay: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  history: readonly PlayHistoryEntry[] | null;
  onPlayHistory?: ((entry: PlayHistoryEntry) => void) | undefined;
  onSave?: ((name: string) => Promise<void>) | undefined;
  /** History was opened: the caller loads it */
  onHistoryOpen?: (() => void) | undefined;
}

export interface NowPlayingTransport {
  status: PlayerStatus;
  /** seconds */
  position: number;
  duration: number | null;
  canPrevious: boolean;
  canNext: boolean;
  onToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (sec: number) => void;
}

const playing = (s: PlayerStatus) => s === 'playing' || s === 'buffering' || s === 'loading';

function Names({ track, onNavigate, center = false }: { track: QueueEntry; onNavigate?: (() => void) | undefined; center?: boolean }) {
  const linked = linkedArtists(track.artist, track.albumArtist, track.artists);
  return (
    <div className={`${styles.names} ${center ? styles.center : ''}`}>
      <h2 className={styles.title} dir="auto">{track.title}</h2>
      <p className={styles.sub} dir="auto" {...lineReset}>
        {linked ? <ArtistLinks artists={linked} onNavigate={onNavigate} /> : track.artist}
        {' · '}
        <AlbumLink albumId={track.albumId} onNavigate={onNavigate}>{track.album}</AlbumLink>
      </p>
    </div>
  );
}

function format(t: QueueEntry): string | null {
  const kind = (t.codec || t.container || '').toUpperCase();
  if (!kind) return null;
  return t.lossless ? `${kind} · Lossless` : kind;
}

/** The facts tagave has about what is playing: who, what, when, which file kind. */
function Credits({ track, onNavigate }: { track: QueueEntry; onNavigate?: (() => void) | undefined }) {
  const linked = linkedArtists(track.albumArtist, track.albumArtist, track.artists);
  const albumArtist = linked ? <ArtistLinks artists={linked} onNavigate={onNavigate} /> : track.albumArtist;
  const rows: Array<[string, ReactNode]> = [
    ['Artist', track.artist && track.artist !== track.albumArtist ? track.artist : albumArtist],
    ...(track.artist && track.artist !== track.albumArtist ? [['Album artist', albumArtist] as [string, ReactNode]] : []),
    ['Album', <AlbumLink albumId={track.albumId} onNavigate={onNavigate}>{track.album}</AlbumLink>],
    ...(track.year ? [['Year', String(track.year)] as [string, ReactNode]] : []),
    ...(track.trackNo ? [['Track', track.discNo > 1 ? `${track.discNo}-${track.trackNo}` : String(track.trackNo)] as [string, ReactNode]] : []),
    ...(format(track) ? [['Format', format(track)] as [string, ReactNode]] : []),
  ];
  return (
    <dl className={styles.credits}>
      {rows.map(([k, v]) => (
        <div key={k} className={styles.credit}><dt>{k}</dt><dd dir="auto">{v}</dd></div>
      ))}
    </dl>
  );
}

function Seek({ t }: { t: NowPlayingTransport }) {
  const [scrub, setScrub] = useState<number | null>(null);
  const total = t.duration && Number.isFinite(t.duration) && t.duration > 0 ? t.duration : null;
  const shown = Math.min(scrub ?? t.position, total ?? Number.POSITIVE_INFINITY);
  const fill = total ? Math.min(100, Math.max(0, (shown / total) * 100)) : 0;
  const commit = () => { if (scrub != null) t.onSeek(scrub); setScrub(null); };
  return (
    <div className={styles.seek}>
      <span className={bar.track} style={{ '--fill': `${fill}%` } as CSSProperties}>
        <input
          type="range"
          className={bar.range}
          min={0}
          max={total ?? 0}
          step={1}
          value={Math.floor(total ? shown : 0)}
          disabled={!total}
          aria-label="Seek"
          aria-valuetext={`${clock(shown)} of ${clock(total)}`}
          onChange={(e) => setScrub(Number(e.currentTarget.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={() => setScrub(null)}
        />
      </span>
      <span className={styles.times} aria-hidden="true"><span>{clock(shown)}</span><span>{total ? `-${clock(Math.max(0, total - shown))}` : clock(null)}</span></span>
    </div>
  );
}

function Keys({ t, size = 'lg' }: { t: NowPlayingTransport; size?: 'lg' | 'md' }) {
  const busy = t.status === 'loading' || t.status === 'buffering';
  return (
    <div className={`${styles.keys} ${size === 'lg' ? styles.keysLg : ''}`} role="group" aria-label="Playback">
      <EmbossIconButton label="Previous track" className={styles.key} disabled={!t.canPrevious} onClick={t.onPrevious}><PreviousIcon /></EmbossIconButton>
      <EmbossIconButton label={playing(t.status) ? 'Pause' : 'Play'} className={styles.play} aria-busy={busy || undefined} onClick={t.onToggle}>
        {busy ? <span className={styles.spinner} aria-hidden="true" /> : playing(t.status) ? <PauseIcon /> : <PlayIcon />}
      </EmbossIconButton>
      <EmbossIconButton label="Next track" className={styles.key} disabled={!t.canNext} onClick={t.onNext}><NextIcon /></EmbossIconButton>
    </div>
  );
}

/** Focus comes in on open, Escape closes, focus goes back to what opened it. */
function useDialogFocus(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => before?.focus?.({ preventScroll: true });
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); onClose(); }
  };
  return { ref, onKeyDown };
}

export interface NowPlayingViewProps extends NowPlayingQueueProps {
  track: QueueEntry;
  onClose: () => void;
  /** a link was followed: the view closes so the page shows */
  onNavigate?: (() => void) | undefined;
  /** the ⋮ of the playing track */
  actions?: ReactNode;
  initialTab?: QueueTab;
}

/** Desktop: the full view over the page, the queue beside the cover. */
export function NowPlayingView(p: NowPlayingViewProps) {
  const [tab, setTab] = useState<QueueTab>(p.initialTab ?? 'next');
  const focus = useDialogFocus(p.onClose);
  const wash = useWashOpacity(p.track.coverUrl);
  const from = p.context;
  return (
    <div ref={focus.ref} className={styles.view} role="dialog" aria-modal="false" aria-label="Now playing" tabIndex={-1} onKeyDown={focus.onKeyDown}>
      <div className={styles.wash} style={p.track.coverUrl ? { backgroundImage: `url("${p.track.coverUrl}")`, opacity: wash } : undefined} aria-hidden="true" />
      <header className={styles.viewHead}>
        <EmbossIconButton label="Close Now playing" place="header" onClick={p.onClose}><ChevronDownIcon /></EmbossIconButton>
        {from && <span className={styles.from}><span className={styles.fromLabel}>{from.kind === 'album' ? 'Playing from album' : 'Playing from playlist'}</span><span className={styles.fromValue} dir="auto">{from.name}</span></span>}
        <span className={styles.headEnd}>{p.actions}</span>
      </header>
      <div className={styles.viewBody}>
        <section className={styles.viewLeft} aria-label="Playing">
          <CoverArt src={p.track.coverUrl} title={p.track.album} className={styles.viewCover} />
          <Names track={p.track} onNavigate={p.onNavigate} center />
          <Credits track={p.track} onNavigate={p.onNavigate} />
        </section>
        <section className={styles.viewRight} aria-label="Queue">
          <h3 className={styles.queueTitle}>Queue</h3>
          <QueuePanel
            tracks={p.tracks} index={p.index} context={p.context} tab={tab}
            onTab={(t) => { setTab(t); if (t === 'history') p.onHistoryOpen?.(); }}
            onPlay={p.onPlay} onMove={p.onMove} onRemove={p.onRemove} onClear={p.onClear}
            history={p.history} onPlayHistory={p.onPlayHistory} onSave={p.onSave}
          />
        </section>
      </div>
    </div>
  );
}

export interface NowPlayingScreenProps extends NowPlayingViewProps, NowPlayingTransport {
  initialSegment?: 'playing' | 'queue';
}

/** Phone: the full screen, Playing | Queue. */
export function NowPlayingScreen(p: NowPlayingScreenProps) {
  const [segment, setSegment] = useState<'playing' | 'queue'>(p.initialSegment ?? 'playing');
  const [tab, setTab] = useState<QueueTab>(p.initialTab ?? 'next');
  const focus = useDialogFocus(p.onClose);
  const wash = useWashOpacity(p.track.coverUrl);
  const next = p.tracks[p.index + 1];
  return (
    <div ref={focus.ref} className={styles.screen} role="dialog" aria-modal="true" aria-label="Now playing" tabIndex={-1} onKeyDown={focus.onKeyDown}>
      <div className={styles.wash} style={p.track.coverUrl ? { backgroundImage: `url("${p.track.coverUrl}")`, opacity: wash } : undefined} aria-hidden="true" />
      <header className={styles.screenHead}>
        <EmbossIconButton label="Close Now playing" place="header" onClick={p.onClose}><ChevronDownIcon /></EmbossIconButton>
        <div className={styles.segment}>
          <SegmentedControl<'playing' | 'queue'> label="Now playing" size="sm" value={segment} onChange={setSegment} options={[{ value: 'playing', label: 'Playing' }, { value: 'queue', label: 'Queue' }]} />
        </div>
        <span className={styles.headEnd}>{p.actions ?? <span className={styles.keySpace} />}</span>
      </header>
      {segment === 'playing' ? (
        <div className={styles.screenBody}>
          <CoverArt src={p.track.coverUrl} title={p.track.album} className={styles.screenCover} />
          <Names track={p.track} onNavigate={p.onNavigate} />
          <Seek t={p} />
          <Keys t={p} />
          {next ? (
            <button type="button" className={styles.peek} onClick={() => { setTab('next'); setSegment('queue'); }}>
              <span className={styles.peekLabel}>Up next</span>
              <span className={styles.peekValue} dir="auto">{next.title} · {next.artist}</span>
              <ChevronRightIcon />
            </button>
          ) : <span className={styles.peekSpace} />}
        </div>
      ) : (
        <div className={styles.screenQueue}>
          <QueuePanel
            tracks={p.tracks} index={p.index} context={p.context} tab={tab}
            onTab={(t) => { setTab(t); if (t === 'history') p.onHistoryOpen?.(); }}
            onPlay={p.onPlay} onMove={p.onMove} onRemove={p.onRemove} onClear={p.onClear}
            history={p.history} onPlayHistory={p.onPlayHistory} onSave={p.onSave}
          />
        </div>
      )}
    </div>
  );
}

export interface MiniPlayerProps {
  track: QueueEntry;
  status: PlayerStatus;
  position: number;
  duration: number | null;
  canNext: boolean;
  message?: string | null | undefined;
  onOpen: () => void;
  onToggle: () => void;
  onNext: () => void;
  onRetry: () => void;
  /** the equalizer glow, behind the mini bar's content (BarGlow) */
  glow?: ReactNode;
}

/** Phone: the mini bar at the foot of the screen. */
export function MiniPlayer({ track, status, position, duration, canNext, message, onOpen, onToggle, onNext, onRetry, glow }: MiniPlayerProps) {
  const total = duration && duration > 0 ? duration : null;
  const fill = total ? Math.min(100, Math.max(0, (position / total) * 100)) : 0;
  const busy = status === 'loading' || status === 'buffering';
  const failed = status === 'error';
  return (
    <section className={styles.mini} aria-label="Player" data-status={status}>
      {status === 'error' ? null : glow}
      <span className={styles.miniProgress} style={{ '--fill': `${fill}%` } as CSSProperties} aria-hidden="true" />
      <button type="button" className={styles.miniOpen} data-mini-open="" onClick={onOpen} aria-label={`Now playing: ${track.title}, ${track.artist}. Open the player`}>
        <CoverArt src={track.coverUrl} title={track.album} compact className={styles.miniCover} />
        <span className={styles.miniNames}>
          <span className={styles.miniTitle} dir="auto">{track.title}</span>
          <span className={`${styles.miniArtist} ${failed ? styles.miniError : ''}`} dir="auto">{failed ? message || 'This track could not be played.' : track.artist}</span>
        </span>
      </button>
      {failed ? (
        <EmbossIconButton label="Retry" className={styles.miniKey} onClick={onRetry}><PlayIcon /></EmbossIconButton>
      ) : (
        <EmbossIconButton label={playing(status) ? 'Pause' : 'Play'} className={styles.miniKey} aria-busy={busy || undefined} onClick={onToggle}>
          {busy ? <span className={styles.spinner} aria-hidden="true" /> : playing(status) ? <PauseIcon /> : <PlayIcon />}
        </EmbossIconButton>
      )}
      <EmbossIconButton label="Next track" className={styles.miniKey} disabled={!canNext} onClick={onNext}><NextIcon /></EmbossIconButton>
      <span className={styles.srOnly} role="status" aria-live="polite">{busy ? 'Loading' : ''}</span>
    </section>
  );
}

