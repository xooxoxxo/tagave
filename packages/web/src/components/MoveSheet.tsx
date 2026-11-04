/**
 * Move to album (0080), from the album page's Maintenance: the songs picked
 * go, files and tags, into another album's folder. Three steps in one sheet:
 *
 *   Album     the library's albums by title or artist; New album… looks a
 *             release up on MusicBrainz by artist and title
 *   Preview   per song: the track it pairs with and how sure, its new path,
 *             its tag changes; songs not on the target stay
 *   Move      the worker writes the tags and moves the files; the page shows
 *             Undo for five seconds after
 *
 * Owner only. Import this file directly or lazily: it pulls in the drawer.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { MOVE_LOW_CONFIDENCE, type AlbumMoveView, type MoveCandidate, type MovePlanFile, type MoveTarget } from '@tagave/shared';
import { Sheet } from './ui/Sheet';
import { Button, Collapse, Input, SearchField } from './ui';
import { useCreateMove, useMove, useMoveAlbums, useMoveTarget, useRunMove } from '../hooks/useAlbumMove';
import { FIELD_LABELS } from '../utils/tagFieldLabels';
import styles from './MoveSheet.module.css';

export interface MoveSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  libraryId: string | undefined;
  albumId: string;
  trackIds: string[];
  /** the album's artist: New album… starts from it */
  artist: string | null;
  side?: 'bottom' | 'right';
  returnFocus?: RefObject<HTMLElement | null> | undefined;
  /** the move is made: the page offers Undo */
  onMoved: (view: AlbumMoveView) => void;
}

type Step = 'album' | 'new' | 'preview';

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const valueText = (v: string | string[] | null) => (v === null || v === '' ? '–' : Array.isArray(v) ? v.join('; ') : v);
const songs = (n: number) => `${n} ${n === 1 ? 'song' : 'songs'}`;
const errText = (e: unknown) => (e as { detail?: string } | null)?.detail ?? null;

export function MoveSheet({ open, onOpenChange, libraryId, albumId, trackIds, artist, side = 'bottom', returnFocus, onMoved }: MoveSheetProps) {
  const [step, setStep] = useState<Step>('album');
  const [moveId, setMoveId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [newArtist, setNewArtist] = useState(artist ?? '');
  const [newTitle, setNewTitle] = useState('');
  const albums = useMoveAlbums(libraryId, open && step === 'album' ? q : '');
  const view = useMove(libraryId, moveId);
  const create = useCreateMove(libraryId, albumId);
  const retarget = useMoveTarget(libraryId);
  const run = useRunMove(libraryId);
  const data = view.data ?? null;
  const state = data?.state ?? null;

  // a fresh sheet each time it opens
  useEffect(() => {
    if (!open) return;
    setStep('album'); setMoveId(null); setQ(''); setNewTitle(''); setNewArtist(artist ?? '');
  }, [open, artist]);

  // the move made: hand it to the page (Undo) and close
  const handed = useRef<string | null>(null);
  useEffect(() => {
    if (data && state === 'done' && handed.current !== data.id) {
      handed.current = data.id;
      onMoved(data);
      onOpenChange(false);
    }
  }, [data, state, onMoved, onOpenChange]);

  const choose = (target: MoveTarget, next: Step) => {
    const done = (v: AlbumMoveView) => { setMoveId(v.id); setStep(next); };
    if (moveId && state && ['choosing', 'ready', 'failed'].includes(state)) retarget.mutate({ moveId, target }, { onSuccess: done });
    else create.mutate({ trackIds, target }, { onSuccess: done });
  };
  const pending = create.isPending || retarget.isPending;
  const requestError = errText(create.error) ?? errText(retarget.error);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Move to album" side={side} returnFocus={returnFocus}>
      <div className={styles.sheet} data-move-sheet="" data-step={step}>
        <header className={styles.head}>
          <h2 className={styles.title}>{step === 'preview' && data?.plan ? data.plan.release.title : 'Move to album'}</h2>
          <div className={styles.sub}>
            {step === 'preview' && data?.plan
              ? [data.plan.release.artist, data.plan.release.year].filter(Boolean).join(' · ')
              : songs(trackIds.length)}
          </div>
        </header>

        {step === 'album' && (
          <>
            <div className={styles.search}>
              <SearchField label="Albums" placeholder="Album or artist" value={q} onChange={(e) => setQ(e.target.value)} slashShortcut={false} autoFocus />
            </div>
            <ul className={styles.list} aria-label="Albums">
              {(albums.data?.items ?? []).filter((a) => a.id !== albumId).map((a) => (
                <li key={a.id}>
                  <button type="button" className={styles.option} disabled={!a.matched || pending} onClick={() => choose({ albumId: a.id }, 'preview')}>
                    <span className={styles.optionTitle}>{a.title}</span>
                    <span className={styles.optionSub}>
                      {a.matched ? [a.artist, a.year, `${a.tracks} tracks`].filter(Boolean).join(' · ') : 'Not identified'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {q.trim() && albums.data && albums.data.items.filter((a) => a.id !== albumId).length === 0 && <p className={styles.status}>No albums</p>}
            <div className={styles.foot}>
              <Button variant="secondary" onClick={() => { setNewTitle(q.trim()); setStep('new'); }}>New album…</Button>
            </div>
          </>
        )}

        {step === 'new' && (
          <NewAlbum
            artist={newArtist} title={newTitle} onArtist={setNewArtist} onTitle={setNewTitle}
            searching={pending || state === 'searching'}
            candidates={state === 'choosing' ? data?.candidates ?? [] : null}
            error={state === 'failed' ? data?.error ?? null : null}
            onSearch={() => choose({ search: { artist: newArtist.trim(), title: newTitle.trim() } }, 'new')}
            onPick={(c) => choose(c.localAlbumId ? { albumId: c.localAlbumId } : { releaseMbid: c.mbid }, 'preview')}
            onBack={() => setStep('album')}
          />
        )}

        {step === 'preview' && (
          <Preview
            view={data}
            running={run.isPending || state === 'moving'}
            runError={errText(run.error)}
            onBack={() => setStep('album')}
            onMove={() => data && run.mutate(data.id)}
          />
        )}
        {requestError && <p className={styles.statusFailed} role="alert">{requestError}</p>}
      </div>
    </Sheet>
  );
}

function NewAlbum({ artist, title, onArtist, onTitle, searching, candidates, error, onSearch, onPick, onBack }: {
  artist: string; title: string; onArtist: (v: string) => void; onTitle: (v: string) => void;
  searching: boolean; candidates: MoveCandidate[] | null; error: string | null;
  onSearch: () => void; onPick: (c: MoveCandidate) => void; onBack: () => void;
}) {
  return (
    <>
      <form className={styles.form} onSubmit={(e) => { e.preventDefault(); if (title.trim()) onSearch(); }}>
        <label className={styles.field}>
          <span className={styles.label}>Artist</span>
          <Input value={artist} onChange={(e) => onArtist(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Album</span>
          <Input value={title} onChange={(e) => onTitle(e.target.value)} autoFocus />
        </label>
        <div className={styles.foot}>
          <Button variant="quiet" type="button" onClick={onBack}>Back</Button>
          <Button variant="secondary" type="submit" disabled={!title.trim() || searching} loading={searching}>Search</Button>
        </div>
      </form>
      {searching && <p className={styles.status} role="status">Searching MusicBrainz</p>}
      {error && <p className={styles.statusFailed} role="alert">{error}</p>}
      {candidates && (candidates.length === 0
        ? <p className={styles.status}>No releases</p>
        : (
          <ul className={styles.list} aria-label="Releases">
            {candidates.map((c) => (
              <li key={c.mbid}>
                <button type="button" className={styles.option} onClick={() => onPick(c)}>
                  <span className={styles.optionTitle}>{c.title}</span>
                  <span className={styles.optionSub}>
                    {[c.artist, c.year, c.country, c.format, `${c.tracks} tracks`, c.localAlbumId ? 'In library' : null].filter(Boolean).join(' · ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </>
  );
}

function Preview({ view, running, runError, onBack, onMove }: {
  view: AlbumMoveView | null; running: boolean; runError: string | null; onBack: () => void; onMove: () => void;
}) {
  const [openRow, setOpenRow] = useState<string | null>(null);
  const plan = view?.plan ?? null;
  const state = view?.state ?? null;
  const files = plan?.files ?? [];
  const moving = useMemo(() => files.filter((f) => f.toPath), [files]);
  const clash = files.some((f) => f.clash);
  const status = !view || state === 'planning' ? 'Pairing songs'
    : state === 'moving' ? 'Moving'
      : state === 'failed' ? view.error ?? 'Stopped'
        : view.blocked ?? (clash ? 'Name taken' : moving.length === 0 ? 'No song pairs with this album' : null);
  const failed = state === 'failed' || !!view?.blocked || clash || (state === 'ready' && moving.length === 0);

  return (
    <>
      {plan && (
        <dl className={styles.facts}>
          <div><dt>Folder</dt><dd className={styles.path}>{plan.toDir}{plan.newFolder && <span className={styles.new}> · New</span>}</dd></div>
          <div><dt>Names</dt><dd>{plan.naming}</dd></div>
          <div><dt>Songs</dt><dd>{moving.length} of {files.length}</dd></div>
        </dl>
      )}
      {status && <p className={failed ? styles.statusFailed : styles.status} role="status">{status}</p>}
      {plan && (
        <ol className={styles.files} aria-label="Songs">
          {files.map((f) => <FileRow key={f.fileId} f={f} open={openRow === f.fileId} onToggle={() => setOpenRow((o) => (o === f.fileId ? null : f.fileId))} />)}
        </ol>
      )}
      <footer className={styles.foot}>
        <Button variant="quiet" onClick={onBack} disabled={running}>Change album</Button>
        <Button
          variant="primary"
          disabled={state !== 'ready' || !!view?.blocked || clash || moving.length === 0 || running}
          loading={running}
          onClick={onMove}
        >
          Move
        </Button>
      </footer>
      {runError && <p className={styles.statusFailed} role="alert">{runError}</p>}
    </>
  );
}

function FileRow({ f, open, onToggle }: { f: MovePlanFile; open: boolean; onToggle: () => void }) {
  const low = f.confidence !== null && f.confidence < MOVE_LOW_CONFIDENCE;
  return (
    <li className={styles.file} data-stays={f.stays ? '' : undefined} data-clash={f.clash ? '' : undefined}>
      <span className={styles.fileTitle}>{f.title}</span>
      {f.toPath && f.target ? (
        <>
          <span className={styles.to}>
            <span className={styles.pair}>{String(f.target.position).padStart(2, '0')} {f.target.title}</span>
            <span className={low ? styles.confLow : styles.conf}>{f.confidence} %</span>
          </span>
          <span className={styles.path} title={f.toPath}>{f.clash ? 'Name taken · ' : ''}{baseName(f.toPath)}</span>
          {f.diff.length > 0 && (
            <>
              <Button variant="quiet" size="sm" className={styles.tagsKey} aria-expanded={open} onClick={onToggle}>
                Tags {f.diff.length}
              </Button>
              <div className={styles.diffSlot}><Collapse open={open}>
                <dl className={styles.diff}>
                  {f.diff.map((d) => (
                    <div key={d.field}>
                      <dt>{FIELD_LABELS[d.field] ?? d.field}</dt>
                      <dd><span className={styles.before}>{valueText(d.before)}</span> → {valueText(d.after)}</dd>
                    </div>
                  ))}
                </dl>
              </Collapse></div>
            </>
          )}
        </>
      ) : (
        <span className={styles.stays}>Stays · {f.stays}</span>
      )}
    </li>
  );
}
