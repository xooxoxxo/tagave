/**
 * A track's (or an album's) ⋮ (direction A, Spotify / Apple Music):
 *
 *   Play next · Add to queue · Add to playlist ›   (with a player / with playlists)
 *   Go to album · Go to artist                     (when given)
 *   extra rows                                     (Remove from this playlist)
 *
 * On a desktop a glass dropdown whose "Add to playlist" opens a submenu of
 * the person's playlists, New playlist first; arrow keys move, Arrow right
 * opens the submenu, Arrow left and Escape close it. On a phone or a touch
 * screen a drawer (TrackDrawer.tsx). Nothing renders when there is nothing
 * to do.
 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from '@tanstack/react-router';
import { AddQueueIcon, ChevronRightIcon, DiscIcon, EmbossIconButton, KebabIcon, PersonIcon, PlayNextIcon, PlaylistIcon, showToast, type EmbossPlace } from '../ui';
import { enqueue, type QueueSource } from '../../player/engine';
import { useCapabilities } from '../../hooks/usePlayer';
import { usePlaylistsOn } from '../../hooks/usePlaylists';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { PlaylistChoices } from './PlaylistChoices';
import type { DrawerRow } from './TrackDrawer';
import menu from '../ui/Menu.module.css';
import styles from './TrackActions.module.css';

const TrackDrawer = lazy(() => import('./TrackDrawer').then((m) => ({ default: m.TrackDrawer })));

export interface ExtraAction {
  key: string;
  label: string;
  icon: ReactNode;
  tone?: 'danger';
  onSelect: () => void;
}

export interface TrackActionsProps {
  /** the trigger's name, e.g. "More for So What" */
  label: string;
  /** the drawer's head on a phone */
  summary: { title: string; subtitle: string; coverUrl: string | null };
  /** what Play next, Add to queue and Add to playlist take */
  source: QueueSource;
  albumId?: string | null | undefined;
  artist?: { id: string; name: string } | null | undefined;
  extra?: readonly ExtraAction[] | undefined;
  place?: EmbossPlace;
  className?: string | undefined;
  /** the drawer (true) or the dropdown (false), whatever the screen (stories) */
  drawer?: boolean | undefined;
  /** open at once (stories) */
  defaultOpen?: boolean | undefined;
  /** open on Add to playlist's list (stories) */
  defaultStep?: 'actions' | 'playlists' | undefined;
  /** what this person can do here, when the caller knows (stories); else read from the player and the modules */
  abilities?: { queue: boolean; playlists: boolean } | undefined;
}

interface Row extends DrawerRow { sub?: boolean; separated?: boolean }

const TILES = new Set(['next', 'queue', 'playlist']);

/** Play next / Add to queue, with the toast that says it happened. */
export async function enqueueWithToast(source: QueueSource, where: 'next' | 'end'): Promise<void> {
  try {
    const n = await enqueue(source, where);
    if (n > 0) showToast({ message: where === 'next' ? 'Playing next' : 'Added to queue' });
  } catch {
    showToast({ message: 'Not added. Try again.', tone: 'danger' });
  }
}

function useRows(p: TrackActionsProps, close: () => void, openPlaylists: () => void): Row[] {
  const navigate = useNavigate();
  const installed = useCapabilities().data?.player?.installed === true;
  const listsOn = usePlaylistsOn();
  const player = p.abilities?.queue ?? installed;
  const lists = p.abilities?.playlists ?? listsOn;
  const rows: Row[] = [];
  const tile = (key: string) => TILES.has(key);
  if (player) {
    rows.push({ key: 'next', label: 'Play next', icon: <PlayNextIcon />, tile: tile('next'), onSelect: () => { close(); void enqueueWithToast(p.source, 'next'); } });
    rows.push({ key: 'queue', label: 'Add to queue', icon: <AddQueueIcon />, tile: tile('queue'), onSelect: () => { close(); void enqueueWithToast(p.source, 'end'); } });
  }
  if (lists) rows.push({ key: 'playlist', label: 'Add to playlist', icon: <PlaylistIcon />, tile: true, sub: true, onSelect: openPlaylists });
  const go: Row[] = [];
  if (p.albumId) go.push({ key: 'album', label: 'Go to album', icon: <DiscIcon />, tile: false, onSelect: () => { close(); void navigate({ to: '/albums/$albumId', params: { albumId: p.albumId! } }); } });
  if (p.artist) go.push({ key: 'artist', label: 'Go to artist', icon: <PersonIcon />, tile: false, onSelect: () => { close(); void navigate({ to: '/artists/$artistId', params: { artistId: p.artist!.id } }); } });
  if (go.length && rows.length) go[0]!.separated = true;
  rows.push(...go);
  const extra = (p.extra ?? []).map((x, n): Row => ({ ...x, tile: false, separated: n === 0 && rows.length > 0, onSelect: () => { close(); x.onSelect(); } }));
  return [...rows, ...extra];
}

export function TrackActions(p: TrackActionsProps) {
  const touch = useMediaQuery('(max-width: 720px), (pointer: coarse)');
  const asDrawer = p.drawer ?? touch;
  const [open, setOpen] = useState(!!p.defaultOpen);
  const [step, setStep] = useState<'actions' | 'playlists'>(p.defaultStep ?? 'actions');
  // the drawer's code loads the first time it opens
  const [drawerWanted, setDrawerWanted] = useState(!!p.defaultOpen);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); setStep('actions'); }, []);
  const rows = useRows(p, close, () => setStep('playlists'));
  if (rows.length === 0) return null;
  const openIt = () => { setDrawerWanted(true); setOpen(true); };
  return (
    <>
      <EmbossIconButton
        ref={trigger}
        label={p.label}
        place={p.place ?? 'page'}
        className={p.className}
        aria-haspopup={asDrawer ? 'dialog' : 'menu'}
        aria-expanded={open}
        onClick={() => (open ? close() : openIt())}
        onKeyDown={(e) => { if (!open && !asDrawer && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); openIt(); } }}
      >
        <KebabIcon />
      </EmbossIconButton>
      {asDrawer ? (
        drawerWanted && (
          <Suspense fallback={null}>
            <TrackDrawer open={open} onOpenChange={(o) => (o ? setOpen(true) : close())} returnFocus={trigger} summary={p.summary} rows={rows} step={step} onStep={setStep} source={p.source} />
          </Suspense>
        )
      ) : open && (
        <Dropdown rows={rows} anchor={trigger} label={p.label} source={p.source} subOpen={step === 'playlists'} onSub={(o) => setStep(o ? 'playlists' : 'actions')} onClose={() => { close(); trigger.current?.focus(); }} />
      )}
    </>
  );
}

function Dropdown({ rows, anchor, label, source, subOpen, onSub, onClose }: {
  rows: Row[]; anchor: RefObject<HTMLButtonElement | null>; label: string; source: QueueSource; subOpen: boolean; onSub: (open: boolean) => void; onClose: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [subPos, setSubPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const t = anchor.current?.getBoundingClientRect();
    const m = list.current;
    if (!t || !m) return;
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    const left = Math.min(Math.max(8, t.right - w), window.innerWidth - w - 8);
    const below = t.bottom + 6;
    setPos({ top: below + h > window.innerHeight - 8 && t.top - 6 - h > 8 ? t.top - 6 - h : below, left });
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [anchor]);

  useLayoutEffect(() => {
    if (!subOpen || !pos) { setSubPos(null); return; }
    const m = list.current?.getBoundingClientRect();
    const item = list.current?.querySelector<HTMLElement>('[data-sub]')?.getBoundingClientRect();
    const s = sub.current;
    if (!m || !item || !s) return;
    const w = s.offsetWidth;
    const h = s.offsetHeight;
    // to the side with room: the left when the right edge is near
    const left = m.right + 4 + w <= window.innerWidth - 8 ? m.right + 4 : Math.max(8, m.left - 4 - w);
    const top = Math.max(8, Math.min(item.top - 6, window.innerHeight - h - 8));
    setSubPos({ top, left });
  }, [subOpen, pos]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (list.current?.contains(t) || sub.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onScroll = (e: Event) => { if (!list.current?.contains(e.target as Node) && !sub.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  const keys = (container: RefObject<HTMLDivElement | null>, inSub: boolean) => (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const els = [...(container.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); els[(n + els.length) % els.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(els.length - 1);
    else if (e.key === 'ArrowRight' && !inSub && (document.activeElement as HTMLElement | null)?.dataset['sub'] !== undefined) {
      e.preventDefault();
      onSub(true);
      requestAnimationFrame(() => sub.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    } else if ((e.key === 'ArrowLeft' || e.key === 'Escape') && inSub) {
      e.preventDefault();
      e.stopPropagation();
      onSub(false);
      list.current?.querySelector<HTMLElement>('[data-sub]')?.focus();
    } else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'Tab') onClose();
  };

  return createPortal(
    <>
      <div ref={list} role="menu" aria-label={label} className={`${menu.menu} ${styles.menu}`} style={pos ?? { visibility: 'hidden', top: 0, left: 0 }} onKeyDown={keys(list, false)}>
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={[menu.item, styles.item, r.tone === 'danger' ? menu.danger : '', r.separated ? menu.separated : ''].filter(Boolean).join(' ')}
            data-active={r.sub && subOpen ? '' : undefined}
            {...(r.sub ? { 'data-sub': '', 'aria-haspopup': 'menu' as const, 'aria-expanded': subOpen } : {})}
            onClick={() => (r.sub ? onSub(!subOpen) : r.onSelect())}
            onPointerEnter={r.sub ? () => onSub(true) : undefined}
          >
            <span className={styles.icon}>{r.icon}</span>
            <span className={styles.text}>{r.label}</span>
            {r.sub && <span className={styles.chevron}><ChevronRightIcon /></span>}
          </button>
        ))}
      </div>
      {subOpen && (
        <div ref={sub} role="menu" aria-label="Add to playlist" className={`${menu.menu} ${styles.menu} ${styles.sub}`} style={subPos ?? { visibility: 'hidden', top: 0, left: 0 }} onKeyDown={keys(sub, true)}>
          <PlaylistChoices source={source} variant="menu" onDone={onClose} />
        </div>
      )}
    </>,
    document.body,
  );
}
