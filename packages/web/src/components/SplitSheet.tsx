/**
 * Whole album in one file (0078): the cut points the file worker found, one
 * row per track (n · title · start → end · length, the cut's shift from the
 * release's lengths and how sure it is), Play around cut, and Split. Opening
 * it finds the cut points when there is no plan yet. Owner only.
 *
 * Import this file directly or lazily: it pulls in the drawer (Sheet).
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { clockOf, sampleMs, shiftLabel, type CutConfidence, type SplitPlan } from '@tagave/shared';
import { Sheet } from './ui/Sheet';
import { Button } from './ui';
import { invalidateAfterSplit, useAlbumSplit, useAnalyzeSplit, useRunSplit } from '../hooks/useAlbumSplit';
import { usePlaybackAvailable } from '../hooks/usePlayer';
import { streamUrl } from '../player/logic';
import styles from './SplitSheet.module.css';

const CONFIDENCE: Record<CutConfidence, string> = { high: 'High', medium: 'Medium', low: 'Low' };
/** Play around cut: this long before and after it. */
const AROUND_S = 3;

export interface SplitSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  libraryId: string | undefined;
  albumId: string;
  title: string;
  artist?: string | null | undefined;
  side?: 'bottom' | 'right';
  returnFocus?: RefObject<HTMLElement | null> | undefined;
}

/** "24-bit · 192 kHz". */
function formatOf(plan: SplitPlan): string {
  const khz = plan.sampleRate / 1000;
  return `${plan.bitsPerSample}-bit · ${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

export function SplitSheet({ open, onOpenChange, libraryId, albumId, title, artist, side = 'bottom', returnFocus }: SplitSheetProps) {
  const qc = useQueryClient();
  const view = useAlbumSplit(libraryId, albumId, open);
  const analyze = useAnalyzeSplit(libraryId, albumId);
  const run = useRunSplit(libraryId, albumId);
  const canPlay = usePlaybackAvailable();
  const asked = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);

  const data = view.data;
  const split = data?.split ?? null;
  const state = split?.state ?? null;

  // opening finds the cut points when there is no plan to check
  useEffect(() => {
    if (!open) { asked.current = false; return; }
    if (!data || asked.current || analyze.isPending) return;
    if (data.eligible && (!split || state === 'done')) {
      asked.current = true;
      analyze.mutate();
    }
  }, [open, data, split, state, analyze]);

  // a finished split: the album and Attention change
  const lastState = useRef(state);
  useEffect(() => {
    if (lastState.current === 'splitting' && state === 'done') void invalidateAfterSplit(qc);
    lastState.current = state;
  }, [state, qc]);

  const stop = () => {
    audio.current?.pause();
    setPlaying(null);
  };
  useEffect(() => { if (!open) stop(); }, [open]);
  useEffect(() => () => audio.current?.pause(), []);

  const plan = split?.plan ?? null;
  const playAround = (n: number, cutSample: number) => {
    if (!plan || !data?.localTrackId) return;
    if (playing === n) { stop(); return; }
    const cutS = cutSample / plan.sampleRate;
    // the stream route starts a transcode at whole seconds (its offset)
    const from = Math.max(0, Math.floor(cutS - AROUND_S));
    const until = cutS + AROUND_S - from;
    audio.current?.pause();
    const el = new Audio(streamUrl(data.localTrackId, 'mp3', 192, from));
    el.ontimeupdate = () => { if (el.currentTime >= until) { el.pause(); setPlaying(null); } };
    el.onended = () => setPlaying(null);
    el.onerror = () => setPlaying(null);
    audio.current = el;
    setPlaying(n);
    void el.play().catch(() => setPlaying(null));
  };

  const busy = state === 'analyzing' || state === 'splitting' || analyze.isPending;
  const status = (() => {
    if (view.isLoading) return null;
    if (analyze.isPending || state === 'analyzing') return 'Finding cut points';
    if (state === 'splitting') return 'Splitting';
    if (state === 'done') return `Split · ${split?.outputs?.length ?? 0} files`;
    if (state === 'failed') return split?.error ?? 'Stopped';
    if (data && !data.eligible) return 'Not one file that fits its release';
    return null;
  })();
  const failed = state === 'failed';
  const ready = state === 'ready' && !!plan;
  const lowCount = ready ? plan!.tracks.filter((t) => t.confidence === 'low').length : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`${title}: split`} side={side} returnFocus={returnFocus}>
      <div className={styles.sheet} data-split-sheet="">
        <header className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          {artist && <div className={styles.sub}>{artist}</div>}
          {plan && (
            <dl className={styles.facts}>
              <div><dt>Tracks</dt><dd>{plan.tracks.length}</dd></div>
              <div><dt>Length</dt><dd>{clockOf(sampleMs(plan.totalSamples, plan.sampleRate))}</dd></div>
              <div><dt>Format</dt><dd>{formatOf(plan)}</dd></div>
              {lowCount > 0 && <div className={styles.low}><dt>Low</dt><dd>{lowCount}</dd></div>}
            </dl>
          )}
        </header>

        {status && <p className={failed ? styles.statusFailed : styles.status} role="status">{status}</p>}

        {plan && state !== 'done' && (
          <ol className={styles.tracks} aria-label="Tracks">
            {plan.tracks.map((t) => {
              const start = sampleMs(t.startSample, plan.sampleRate);
              const end = sampleMs(t.endSample, plan.sampleRate);
              const low = t.confidence === 'low';
              return (
                <li key={t.n} className={styles.track} data-low={low || undefined}>
                  <span className={styles.n}>{String(t.n).padStart(2, '0')}</span>
                  <span className={styles.name}>{t.title}</span>
                  <span className={styles.times}>
                    {clockOf(start)} → {clockOf(end)}
                    <span className={styles.len}>{clockOf(end - start)}</span>
                  </span>
                  <span className={styles.cut}>
                    {t.shiftMs !== null && t.confidence && (
                      <>
                        <span className={styles.shift}>{shiftLabel(t.shiftMs)}</span>
                        <span className={low ? styles.confLow : styles.conf}>{CONFIDENCE[t.confidence]}</span>
                      </>
                    )}
                  </span>
                  <span className={styles.play}>
                    {t.n > 1 && canPlay && data?.localTrackId && (
                      <Button
                        variant="quiet"
                        size="sm"
                        aria-label={`Play around cut ${t.n}`}
                        aria-pressed={playing === t.n}
                        onClick={() => playAround(t.n, t.startSample)}
                      >
                        {playing === t.n ? 'Stop' : 'Play'}
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        <footer className={styles.foot}>
          {ready && data && !data.writable && <span className={styles.note}>Music folder is read-only</span>}
          {failed && data?.eligible && (
            <Button variant="secondary" onClick={() => analyze.mutate()} loading={analyze.isPending}>Find cut points</Button>
          )}
          {state !== 'done' && (
            <Button
              variant="primary"
              disabled={!ready || !data?.writable || busy || run.isPending}
              loading={state === 'splitting' || run.isPending}
              onClick={() => split && run.mutate(split.id)}
            >
              Split
            </Button>
          )}
          {state === 'done' && <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>}
        </footer>
        {run.error && <p className={styles.statusFailed} role="alert">{(run.error as { detail?: string }).detail ?? 'Not split'}</p>}
      </div>
    </Sheet>
  );
}
