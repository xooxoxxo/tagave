/**
 * The album's tracks, shaped like a player's list (Spotify, Qobuz): a leading
 * slot (the number now, play later), the title with the artist under it only
 * when it is not the album's, and the length. No file facts in the row: they
 * open in place on a long press (touch), from the row's "⋯" in Maintenance,
 * and as the row's hover text. In Maintenance missing tracks sit in the list
 * as dimmed rows, and a track whose file or title needs a look carries a mark.
 */
import { useRef, useState } from 'react';
import { Collapse, IconButton, MoreIcon } from '../components/ui';
import type { DetailTrack } from './albumDetailTypes';
import { dur, fileLine, trackArtistIfDifferent } from './albumFormat';
import styles from './AlbumTracks.module.css';

interface MissingRow { disc: number; position: number; title: string; lengthMs: number | null }

type Entry =
  | { kind: 'track'; key: string; no: number | null; track: DetailTrack }
  | { kind: 'missing'; key: string; no: number; missing: MissingRow };

/** One list per disc, missing tracks slotted in by position. */
export function trackEntries(tracks: readonly DetailTrack[], missing: readonly MissingRow[]): Array<{ disc: number; entries: Entry[] }> {
  const discs = new Map<number, Entry[]>();
  const push = (d: number, e: Entry) => discs.set(d, [...(discs.get(d) ?? []), e]);
  for (const t of tracks) push(t.discNo ?? 1, { kind: 'track', key: t.id, no: t.trackNo, track: t });
  for (const m of missing) push(m.disc || 1, { kind: 'missing', key: `m-${m.disc}-${m.position}`, no: m.position, missing: m });
  return [...discs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([disc, entries]) => ({
      disc,
      // stable: tracks keep their order; a missing row goes before the first track numbered after it
      entries: entries
        .map((e, i) => ({ e, i }))
        .sort((x, y) => {
          const a = x.e.no ?? Number.MAX_SAFE_INTEGER;
          const b = y.e.no ?? Number.MAX_SAFE_INTEGER;
          return a - b || x.i - y.i;
        })
        .map(({ e }) => e),
    }));
}

export interface AlbumTracksProps {
  tracks: DetailTrack[];
  missingTracks: MissingRow[];
  discCount: number | null;
  /** every spelling of the album's artist (local credit, release credit, linked names) */
  albumArtists: Array<string | null | undefined>;
  /** the linked album artists' names */
  artistNames: string[];
  maintenance: boolean;
}

export function AlbumTracks({ tracks, missingTracks, discCount, albumArtists, artistNames, maintenance }: AlbumTracksProps) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const press = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const toggle = (id: string) => setOpenFile((cur) => (cur === id ? null : id));

  if (tracks.length === 0 && (!maintenance || missingTracks.length === 0)) {
    return <p className={styles.empty}>No track information is available for this album yet.</p>;
  }
  const groups = trackEntries(tracks, maintenance ? missingTracks : []);
  const multiDisc = (discCount ?? 1) > 1 || groups.length > 1;

  const startPress = (e: React.PointerEvent, id: string) => {
    if (e.pointerType !== 'touch') return;
    const timer = setTimeout(() => { press.current = null; toggle(id); }, 480);
    press.current = { id, timer };
  };
  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  return (
    <div className={styles.tracks}>
      {groups.map(({ disc, entries }) => (
        <section key={disc} className={styles.disc} aria-label={multiDisc ? `Disc ${disc}` : 'Tracks'}>
          {multiDisc && <h3 className={styles.discHeader}>Disc {disc}</h3>}
          <ol className={styles.list}>
            {entries.map((e) => {
              if (e.kind === 'missing') {
                return (
                  <li key={e.key} className={styles.item}><div className={`${styles.row} ${styles.missing}`}>
                    <span className={styles.lead}>{e.no}</span>
                    <span className={styles.main}>
                      <span className={styles.title}>{e.missing.title}</span>
                      <span className={styles.sub}>Not in your library</span>
                    </span>
                    <span className={styles.len}>{dur(e.missing.lengthMs)}</span>
                    {maintenance && <span className={styles.rowTool} aria-hidden="true" />}
                  </div></li>
                );
              }
              const t = e.track;
              const artist = trackArtistIfDifferent(t.artist, albumArtists, artistNames);
              const file = fileLine(t);
              const titleDiffers = !!t.canonicalTitle && !!t.title && t.canonicalTitle.trim().toLowerCase() !== t.title.trim().toLowerCase();
              const fileError = t.file.status === 'error';
              const open = openFile === t.id;
              return (
                <li key={e.key} className={styles.item}>
                  <div
                    className={`${styles.row} ${fileError && maintenance ? styles.error : ''} ${open ? styles.rowOpen : ''}`}
                    title={file ? `${file}\n${t.file.relPath}` : t.file.relPath}
                    onPointerDown={(ev) => startPress(ev, t.id)}
                    onPointerUp={endPress}
                    onPointerLeave={endPress}
                    onPointerCancel={endPress}
                    onContextMenu={(ev) => { if (press.current || open) ev.preventDefault(); }}
                  >
                    <span className={styles.lead}>{t.trackNo ?? '–'}</span>
                    <span className={styles.main}>
                      <span className={styles.title}>
                        {t.title ?? '(untitled)'}
                        {maintenance && (titleDiffers || fileError) && (
                          <span
                            className={fileError ? styles.markBad : styles.mark}
                            title={fileError ? 'This file could not be read' : `The release calls it “${t.canonicalTitle}”`}
                          >
                            <span className={styles.srOnly}>{fileError ? ' (file could not be read)' : ` (the release calls it ${t.canonicalTitle})`}</span>
                          </span>
                        )}
                      </span>
                      {artist && <span className={styles.sub}>{artist}</span>}
                    </span>
                    <span className={styles.len}>{dur(t.durationMs)}</span>
                    {maintenance && (
                      <IconButton
                        label={open ? `Hide file details for ${t.title ?? 'this track'}` : `File details for ${t.title ?? 'this track'}`}
                        variant="quiet"
                        size="sm"
                        className={styles.rowTool}
                        aria-expanded={open}
                        onClick={() => toggle(t.id)}
                      >
                        <MoreIcon />
                      </IconButton>
                    )}
                  </div>
                  <Collapse open={open}>
                    <dl className={styles.details}>
                      {file && <div><dt>File</dt><dd>{file}</dd></div>}
                      <div><dt>Path</dt><dd className={styles.path}>{t.file.relPath}</dd></div>
                      {t.origin === 'cue' && t.cueStartMs !== null && <div><dt>Starts at</dt><dd>{dur(t.cueStartMs)} in the CUE image</dd></div>}
                      {titleDiffers && <div><dt>Release title</dt><dd>{t.canonicalTitle}</dd></div>}
                      {fileError && <div><dt>Status</dt><dd>This file could not be read</dd></div>}
                    </dl>
                  </Collapse>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
