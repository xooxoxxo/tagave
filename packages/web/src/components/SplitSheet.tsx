/** Review and audition the cut points of a whole-album FLAC before writing tracks. */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { clockOf, sampleMs, withSplitCuts, type SplitCuts, type SplitPlan } from '@tagave/shared';
import { Sheet } from './ui/Sheet';
import { Button, LinkButton } from './ui';
import { MaintenanceTaskStatus } from './MaintenanceTaskStatus';
import { invalidateAfterSplit, useAlbumSplit, useAnalyzeSplit, useRunSplit } from '../hooks/useAlbumSplit';
import { usePlaybackAvailable } from '../hooks/usePlayer';
import { streamUrl } from '../player/logic';
import styles from './SplitSheet.module.css';

const AROUND_S = 3;

export interface SplitSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  libraryId: string | undefined;
  albumId: string;
  title: string;
  artist?: string | null | undefined;
  coverUrl?: string | null | undefined;
  side?: 'bottom' | 'right';
  returnFocus?: RefObject<HTMLElement | null> | undefined;
  confirm?: { splitId: string; label: string; cuts: SplitCuts; onConfirm: (splitId: string, cuts: SplitCuts) => void } | undefined;
}

function formatOf(plan: SplitPlan): string {
  return `${plan.bitsPerSample}-bit FLAC · ${plan.sampleRate / 1000} kHz`;
}

function cutClock(sample: number, rate: number): string {
  const ms = Math.round(sampleMs(sample, rate));
  return `${clockOf(ms - ms % 1000)}.${String(ms % 1000).padStart(3, '0')}`;
}

export function SplitSheet({ open, onOpenChange, libraryId, albumId, title, artist, coverUrl, side = 'bottom', returnFocus, confirm }: SplitSheetProps) {
  const qc = useQueryClient();
  const view = useAlbumSplit(libraryId, albumId, open);
  const analyze = useAnalyzeSplit(libraryId, albumId);
  const run = useRunSplit(libraryId, albumId);
  const canPlay = usePlaybackAvailable();
  const asked = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const stopAt = useRef(Infinity);
  const playRequest = useRef(0);
  const [preview, setPreview] = useState<'loading' | 'playing' | 'error' | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [cuts, setCuts] = useState<SplitCuts>(confirm?.cuts ?? []);
  const [position, setPosition] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const reviewHeading = useRef<HTMLHeadingElement | null>(null);

  const data = view.data;
  const split = data?.split ?? null;
  const state = split?.state ?? null;
  const original = split?.plan ?? null;
  const plan = original ? withSplitCuts(original, cuts) ?? original : null;
  const mismatched = !!confirm && !!split && confirm.splitId !== split.id;
  const ready = state === 'ready' && !!plan && !mismatched;
  const busy = state === 'analyzing' || state === 'splitting' || analyze.isPending || run.isPending;
  const trackId = data?.localTrackId;
  const previewAvailable = open && ready && canPlay && !!trackId;

  useEffect(() => {
    if (reviewing) reviewHeading.current?.focus();
  }, [reviewing]);

  useEffect(() => {
    if (!open) { asked.current = false; return; }
    if (!data || asked.current || analyze.isPending || confirm) return;
    if (data.eligible && (!split || state === 'done' || state === 'undone')) {
      asked.current = true;
      analyze.mutate();
    }
  }, [open, data, split, state, analyze, confirm]);

  const lastState = useRef(state);
  useEffect(() => {
    if (lastState.current === 'splitting' && state === 'done') void invalidateAfterSplit(qc);
    lastState.current = state;
  }, [state, qc]);

  // Prime the original range-capable FLAC stream. Seeking it preserves the
  // fractional position, unlike the player's whole-second transcode offset.
  useEffect(() => {
    if (!previewAvailable || !trackId) return;
    const el = new Audio();
    audio.current = el;
    el.preload = 'metadata';
    el.src = streamUrl(trackId, 'original', 0);
    el.ontimeupdate = () => {
      if (el.currentTime < stopAt.current) return;
      el.pause();
      setPreview(null);
    };
    el.onended = () => setPreview(null);
    el.onerror = () => setPreview('error');
    return () => {
      playRequest.current++;
      el.pause();
      el.onended = el.onerror = el.ontimeupdate = null;
      el.removeAttribute('src');
      el.load();
      audio.current = null;
    };
  }, [previewAvailable, trackId]);

  const stop = () => {
    playRequest.current++;
    audio.current?.pause();
    setPreview(null);
  };
  const listen = (sample: number, around = false) => {
    const el = audio.current;
    if (!el || !plan) return;
    const request = ++playRequest.current;
    const seconds = sample / plan.sampleRate;
    const from = around ? Math.max(0, seconds - AROUND_S) : seconds;
    stopAt.current = seconds + AROUND_S;
    setPreview('loading');
    if (el.error) el.load();
    el.currentTime = from;
    void el.play().then(() => {
      if (playRequest.current === request) setPreview('playing');
    }).catch(() => {
      if (playRequest.current === request) setPreview('error');
    });
  };

  const active = ready ? plan.tracks.find((t) => t.n === selected) : null;
  const previous = active && plan ? plan.tracks[active.n - 2] : null;
  const typedSample = position === null || !plan || !position.trim() ? null : Math.round(Number(position) * plan.sampleRate);
  const invalidPosition = position !== null && (!active || !previous || typedSample === null ||
    !Number.isSafeInteger(typedSample) || typedSample <= previous.startSample || typedSample >= active.endSample);
  const moveCut = (sample: number) => {
    if (!active || !original || !previous) return;
    const next = Math.min(active.endSample - 1, Math.max(previous.startSample + 1, sample));
    const start = original.tracks.find((t) => t.n === active.n)?.startSample;
    setCuts([...cuts.filter((cut) => cut.track !== active.n), ...(next === start ? [] : [{ track: active.n, sample: next }])]);
    if (preview === 'playing' || preview === 'loading') listen(next);
  };
  const selectCut = (n: number) => {
    stop();
    setPosition(null);
    setSelected(n === selected ? null : n);
  };

  const review = () => {
    if (!split || !plan || invalidPosition) return;
    stop();
    if (confirm) { confirm.onConfirm(split.id, cuts); return; }
    setReviewing(true);
  };

  const analysis = state === 'analyzing' || analyze.isPending;
  const writing = state === 'splitting' || run.isPending;
  const task = split?.task;
  const done = state === 'done';
  const status = view.isLoading ? 'Loading split plan'
    : view.isError ? 'Couldn’t load the split plan'
      : mismatched ? 'This plan has changed. Reopen the Tag Plan to review the current cuts.'
        : split?.waitingForWorker ? 'Waiting for the file worker'
          : analysis ? 'Finding cut points'
            : writing ? 'Writing FLAC tracks'
              : state === 'failed' ? split?.error ?? 'The split stopped'
                : data && !data.eligible && !done ? 'This album is no longer eligible for a one-file split' : null;
  const outputCount = split?.outputs?.length ?? 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`Split ${title}`} side={side} returnFocus={returnFocus} className={styles.popup}>
      <div className={styles.sheet} data-split-sheet="">
        <header className={styles.head}>
          <div className={styles.art} aria-hidden="true">
            {coverUrl ? <img src={coverUrl} alt="" /> : <span className={styles.disc} />}
          </div>
          <div className={styles.identity}>
            <p className={styles.context}>{done ? 'Split complete' : 'Split album'}</p>
            <h2>{title}</h2>
            {artist && <p>{artist}</p>}
            {plan && <p className={styles.format}>{formatOf(plan)} · {clockOf(sampleMs(plan.totalSamples, plan.sampleRate))}</p>}
          </div>
        </header>

        {done ? (
          <section className={styles.receipt} aria-label="Split result">
            <h3>{outputCount} FLAC {outputCount === 1 ? 'track' : 'tracks'} created</h3>
            <p>The original is in Trash. You can restore it from Library care.</p>
            <ol aria-label="Created files">
              {split?.outputs?.map((file) => <li key={file}>{file.split('/').at(-1)}</li>)}
            </ol>
          </section>
        ) : (
          <>
            {(task || status) && (
              <div className={styles.status} data-error={state === 'failed' || view.isError || undefined}>
                {task && libraryId ? <MaintenanceTaskStatus task={task} libraryId={libraryId} /> : <p role="status">{status}</p>}
                {busy && <p>You can close this panel. Follow the task in Background activity.</p>}
                {view.isError && <Button variant="quiet" size="sm" onClick={() => void view.refetch()}>Reload plan</Button>}
              </div>
            )}
            {ready && reviewing && (
              <section className={styles.receipt} aria-labelledby="split-review-heading">
                <h3 id="split-review-heading" ref={reviewHeading} tabIndex={-1}>Split into {plan.tracks.length} FLAC files?</h3>
                <p>Tagave writes a file for each track at the reviewed cuts, then moves the original to Trash.</p>
              </section>
            )}
            {ready && !reviewing && (
              <section aria-label="Track boundaries" className={styles.editor}>
                <h3>Where each track starts</h3>
                <p>Select a cut to fine-tune it. Moving it also changes where the previous track ends.</p>
                <ol className={styles.tracks} aria-label="Tracks">
                  {plan.tracks.map((track) => (
                    <li key={track.n} className={styles.track} data-selected={selected === track.n || undefined}>
                      <span className={styles.number}>{String(track.n).padStart(2, '0')}</span>
                      <div className={styles.trackText}>
                        <span className={styles.name}>{track.title}</span>
                        <span className={styles.times}>
                          Starts {cutClock(track.startSample, plan.sampleRate)} · {clockOf(sampleMs(track.endSample - track.startSample, plan.sampleRate))} long
                          {cuts.some((cut) => cut.track === track.n) && <span> · Adjusted</span>}
                          {track.confidence === 'low' && <strong> · Check this cut</strong>}
                        </span>
                      </div>
                      {track.n > 1 && (
                        <Button variant="quiet" size="sm" aria-label={`Adjust cut for ${track.title}`} aria-expanded={selected === track.n}
                          onClick={() => selectCut(track.n)}>{selected === track.n ? 'Hide cut' : 'Adjust cut'}</Button>
                      )}
                      {active === track && (
                        <div className={styles.controls}>
                          <div className={styles.adjust}>
                            <Button variant="secondary" size="sm" aria-label="Move cut 100 milliseconds earlier"
                              onClick={() => { setPosition(null); moveCut(track.startSample - Math.round(plan.sampleRate / 10)); }}>−100 ms</Button>
                            <label className={styles.position}>Start in seconds
                              <input type="number" step="0.001" value={position ?? (track.startSample / plan.sampleRate).toFixed(3)}
                                aria-invalid={invalidPosition || undefined}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  setPosition(value);
                                  const sample = Math.round(Number(value) * plan.sampleRate);
                                  if (value.trim() && previous && Number.isSafeInteger(sample) && sample > previous.startSample && sample < track.endSample) moveCut(sample);
                                }} />
                            </label>
                            <Button variant="secondary" size="sm" aria-label="Move cut 100 milliseconds later"
                              onClick={() => { setPosition(null); moveCut(track.startSample + Math.round(plan.sampleRate / 10)); }}>+100 ms</Button>
                          </div>
                          {invalidPosition && <p role="alert">Enter a time between the adjacent track boundaries.</p>}
                          {cuts.some((cut) => cut.track === track.n) && (
                            <Button variant="quiet" size="sm" onClick={() => {
                              const start = original?.tracks.find((t) => t.n === track.n)?.startSample;
                              if (start !== undefined) { setPosition(null); moveCut(start); }
                            }}>Reset cut</Button>
                          )}
                          {previewAvailable ? (
                            <div className={styles.transport}>
                              <Button variant="secondary" size="sm" disabled={invalidPosition} onClick={() => listen(track.startSample)}>Play from cut</Button>
                              <Button variant="quiet" size="sm" disabled={invalidPosition} onClick={() => listen(track.startSample, true)}>Hear transition</Button>
                              {(preview === 'playing' || preview === 'loading') && <Button variant="quiet" size="sm" onClick={stop}>Stop</Button>}
                              {preview === 'loading' && <span role="status">Opening audio…</span>}
                              {preview === 'error' && <span role="alert">Couldn’t play the original FLAC. Check the player and try again.</span>}
                            </div>
                          ) : <p>Preview needs a connected player that can stream this album.</p>}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}

        <footer className={styles.foot}>
          {ready && !data?.writable && <p>Music folder is read-only.</p>}
          {ready && cuts.length > 0 && <p>{cuts.length} {cuts.length === 1 ? 'cut adjusted' : 'cuts adjusted'} · Saved when you apply the split.</p>}
          {run.error && <p role="alert">{(run.error as { detail?: string }).detail ?? 'Couldn’t start the split.'}</p>}
          {analyze.error && <p role="alert">Couldn’t queue cut point analysis.</p>}
          <div className={styles.actions}>
            {done && <LinkButton variant="quiet" size="sm" to="/work" search={{ tab: 'deleting' }}>Open Trash</LinkButton>}
            {!done && busy && <LinkButton variant="quiet" size="sm" to="/jobs">Background activity</LinkButton>}
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
            {(state === 'failed' || analyze.isError) && data?.eligible && !task && (
              <Button size="sm" disabled={analyze.isPending} onClick={() => analyze.mutate()}>Retry analysis</Button>
            )}
            {ready && reviewing && <Button variant="quiet" size="sm" disabled={run.isPending} onClick={() => setReviewing(false)}>Back to cuts</Button>}
            {ready && (
              <Button size="sm" disabled={!data?.writable || busy || invalidPosition} onClick={() => {
                if (reviewing && split) run.mutate({ splitId: split.id, cuts });
                else review();
              }}>
                {run.isPending ? 'Queuing split…' : reviewing ? 'Split album' : confirm?.label ?? `Review split · ${plan.tracks.length} tracks`}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </Sheet>
  );
}
