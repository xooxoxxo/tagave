/**
 * The queue inside Now Playing (direction B, Qobuz): Up next | History.
 *
 *   Up next   the playing track, "Next in queue" (what the person added with
 *             Play next or Add to queue; Clear takes those out), then
 *             "Next from <album or playlist>". Every row still to come has a
 *             handle (drag it, or Arrow up / down on it) and a remove key; a
 *             row plays its track. Save as playlist keeps the whole queue.
 *   History   the person's plays, newest first (from the server, so plays on
 *             their other devices are there too); a row plays its track next.
 *
 * Each song still to come, and each played one still in the library, has
 * every song's ⋮ (TrackActions); the playing one has it in the header.
 */
import { useRef, useState, type CSSProperties, type FormEvent, type ReactElement, type ReactNode } from 'react';
import type { PlayHistoryEntry, QueueContext } from '@tagave/shared';
import { Button, CloseIcon, CoverArt, EmbossIconButton, GripIcon, SaveListIcon, SegmentedControl } from '../ui';
import { clock } from '../../player/logic';
import type { QueueEntry } from '../../player/engine';
import { useDragReorder } from './useDragReorder';
import { TrackActions } from './TrackActions';
import { linkedArtists } from '../NowPlayingLinks';
import styles from './QueuePanel.module.css';

export type QueueTab = 'next' | 'history';

export interface QueuePanelProps {
  tracks: readonly QueueEntry[];
  index: number;
  context: QueueContext | null;
  tab: QueueTab;
  onTab: (t: QueueTab) => void;
  onPlay: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  /** the person's plays (History); null while loading */
  history: readonly PlayHistoryEntry[] | null;
  onPlayHistory?: ((entry: PlayHistoryEntry) => void) | undefined;
  /** Save as playlist (only with the playlists module): resolves when saved */
  onSave?: ((name: string) => Promise<void>) | undefined;
  /** each row's ⋮ (every song's menu); off where there is no app around it (tests) */
  menus?: boolean | undefined;
}

const REASON: Record<string, string> = { not_scanned: 'Not on the player yet', no_file: 'File missing', cue: 'Inside a CUE image' };

/** A row's ⋮: every song's menu. */
function songMenu(t: { localTrackId: string; title: string; artist: string; album: string; coverUrl: string | null; albumId: string | null; albumArtist?: string; artists?: QueueEntry['artists'] }): ReactNode {
  return (
    <TrackActions
      label={`More for ${t.title}`}
      className={styles.more}
      summary={{ title: t.title, subtitle: [t.artist, t.album].filter(Boolean).join(' · '), coverUrl: t.coverUrl }}
      source={{ trackIds: [t.localTrackId] }}
      albumId={t.albumId}
      artist={linkedArtists(t.artist, t.albumArtist ?? '', t.artists)?.[0] ?? null}
    />
  );
}

function Row({ t, state, handle, dragged, onPlay, onRemove, menu }: {
  t: Pick<QueueEntry, 'title' | 'artist' | 'album' | 'coverUrl' | 'durationMs' | 'available' | 'reason'>;
  state: 'current' | 'next' | 'played';
  handle?: Record<string, unknown> | undefined;
  dragged?: { dy: number } | undefined;
  onPlay?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
  menu?: ReactNode;
}) {
  const style = dragged ? ({ '--dy': `${dragged.dy}px` } as CSSProperties) : undefined;
  return (
    <li className={styles.row} data-state={state} data-drag-row={handle ? '' : undefined} data-lifted={dragged ? '' : undefined} data-available={t.available ? undefined : 'no'} style={style}>
      {handle ? (
        <button type="button" className={styles.grip} aria-label={`Move ${t.title}`} title="Drag, or use the arrow keys" {...handle}><GripIcon /></button>
      ) : state === 'current' ? <span className={styles.lead} aria-hidden="true"><span className={styles.nowMark} /></span> : <span className={styles.lead} aria-hidden="true" />}
      <button type="button" className={styles.main} onClick={onPlay} disabled={!onPlay || !t.available} aria-current={state === 'current' ? 'true' : undefined}>
        <CoverArt src={t.coverUrl} title={t.album || t.title} compact className={styles.thumb} />
        <span className={styles.names}>
          <span className={styles.title} dir="auto">{t.title}</span>
          <span className={styles.artist} dir="auto">{t.available ? t.artist : REASON[t.reason ?? ''] ?? 'Cannot be played'}</span>
        </span>
        <span className={styles.time}>{t.durationMs ? clock(t.durationMs / 1000) : ''}</span>
      </button>
      {menu}
      {onRemove && <EmbossIconButton label={`Remove ${t.title}`} className={styles.remove} onClick={onRemove}><CloseIcon /></EmbossIconButton>}
    </li>
  );
}

function SaveAs({ onSave }: { onSave: (name: string) => Promise<void> }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim());
      setNaming(false);
      setName('');
    } catch {
      setError('Not saved. Try again.');
    } finally {
      setBusy(false);
    }
  };
  if (!naming) {
    return (
      <div className={styles.foot}>
        <Button size="sm" variant="secondary" onClick={() => setNaming(true)}><span className={styles.btnIcon}><SaveListIcon /></span>Save as playlist</Button>
      </div>
    );
  }
  return (
    <form className={styles.nameForm} onSubmit={(e) => void submit(e)}>
      <label className={styles.srOnly} htmlFor="queue-save-name">Playlist name</label>
      <input id="queue-save-name" className={styles.nameField} value={name} maxLength={200} autoFocus placeholder="Name" onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNaming(false); } }} />
      <Button size="sm" type="submit" loading={busy} disabled={!name.trim()}>Save</Button>
      <Button size="sm" variant="quiet" onClick={() => setNaming(false)}>Cancel</Button>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  );
}

export function QueuePanel({ tracks, index, context, tab, onTab, onPlay, onMove, onRemove, onClear, history, onPlayHistory, onSave, menus = false }: QueuePanelProps) {
  const list = useRef<HTMLDivElement>(null);
  // rows on screen: the playing track (position 0) and what comes after it
  const base = Math.max(0, index);
  const shown = tracks.slice(base);
  const { drag, handle } = useDragReorder({
    list,
    canMove: (p) => p > 0 && p < shown.length,
    onMove: (from, to) => onMove(base + from, base + to),
  });
  // "Next in queue": the run of tracks added by hand right after the playing one
  let queuedEnd = 1;
  while (queuedEnd < shown.length && shown[queuedEnd]!.origin === 'queued') queuedEnd++;
  const rowFor = (t: QueueEntry, p: number) => (
    <Row
      key={t.uid}
      t={t}
      state={p === 0 && index >= 0 ? 'current' : 'next'}
      handle={p > 0 ? handle(p) : undefined}
      dragged={drag?.from === p ? { dy: drag.dy } : undefined}
      onPlay={p === 0 ? undefined : () => onPlay(base + p)}
      onRemove={p > 0 ? () => onRemove(base + p) : undefined}
      menu={menus && p > 0 && t.localTrackId ? songMenu(t) : undefined}
    />
  );
  const dropLine = (p: number) => (drag && drag.to === p && drag.to !== drag.from ? <li className={styles.drop} aria-hidden="true" data-after={drag.to > drag.from ? '' : undefined} /> : null);
  const withDrop = (p: number, node: ReactElement) => (drag && drag.to > drag.from ? <>{node}{dropLine(p)}</> : <>{dropLine(p)}{node}</>);

  return (
    <div className={styles.panel}>
      <div className={styles.tabs}>
        <SegmentedControl<QueueTab> label="Queue" size="sm" value={tab} onChange={onTab} options={[{ value: 'next', label: 'Up next' }, { value: 'history', label: 'History' }]} />
      </div>
      {tab === 'next' ? (
        <div ref={list} className={styles.groups}>
          {shown.length === 0 ? <p className={styles.empty}>Nothing in the queue</p> : (
            <>
              <h4 className={styles.groupHead}>Now playing</h4>
              <ol className={styles.list}>{withDrop(0, rowFor(shown[0]!, 0))}</ol>
              {queuedEnd > 1 && (
                <>
                  <div className={styles.groupRow}>
                    <h4 className={styles.groupHead}>Next in queue</h4>
                    <button type="button" className={styles.textKey} onClick={onClear}>Clear</button>
                  </div>
                  <ol className={styles.list}>{shown.slice(1, queuedEnd).map((t, n) => withDrop(n + 1, rowFor(t, n + 1)))}</ol>
                </>
              )}
              {queuedEnd < shown.length && (
                <>
                  <h4 className={styles.groupHead}>{context ? `Next from ${context.name}` : 'Next'}</h4>
                  <ol className={styles.list}>{shown.slice(queuedEnd).map((t, n) => withDrop(queuedEnd + n, rowFor(t, queuedEnd + n)))}</ol>
                </>
              )}
              {onSave && tracks.length > 0 && <SaveAs onSave={onSave} />}
            </>
          )}
        </div>
      ) : (
        <div className={styles.groups}>
          {history === null ? <p className={styles.empty} aria-busy="true">…</p> : history.length === 0 ? <p className={styles.empty}>Nothing played yet</p> : (
            <ol className={styles.list}>
              {history.map((h) => (
                <Row
                  key={h.id}
                  state="played"
                  t={{ title: h.title, artist: h.artist ?? '', album: h.album ?? '', coverUrl: h.coverUrl, durationMs: h.durationMs, available: !!h.localTrackId, reason: h.localTrackId ? null : 'no_file' }}
                  onPlay={h.localTrackId && onPlayHistory ? () => onPlayHistory(h) : undefined}
                  menu={menus && h.localTrackId ? songMenu({ localTrackId: h.localTrackId, title: h.title, artist: h.artist ?? '', album: h.album ?? '', coverUrl: h.coverUrl, albumId: h.albumId }) : undefined}
                />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
