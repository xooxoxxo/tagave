/**
 * A deck's waveform (GET /me/dj/peaks/:id, ~900 bins), with a tick on each
 * downbeat along its top. It is drawn twice, once in the waveform's ink and
 * once in the accent, only when its size, the theme or the peaks change;
 * the played part (the accent copy, clipped) and the playhead move by
 * transform alone, each frame, from `position()`. A slider to assistive
 * technology: press or drag to scrub, ←/→ a bar (four beats; 5 s without a
 * grid), Home and End.
 */
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { deckClock, downbeats } from '../../player/deckMath';
import styles from './Waveform.module.css';

export interface WaveformProps {
  label: string;
  peaks: number[] | null;
  durationSec: number | null;
  bpm: number | null;
  firstBeatSec: number | null;
  /** seconds into the track, read each frame */
  position: () => number;
  onSeek: (sec: number) => void;
}

const HEIGHT = 72;

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function draw(canvas: HTMLCanvasElement, width: number, peaks: number[] | null, ticks: number[], colour: string) {
  const dpr = globalThis.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(width * dpr));
  const H = Math.round(HEIGHT * dpr);
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext('2d');
  if (!c) return;
  c.clearRect(0, 0, W, H);
  c.fillStyle = colour;
  if (peaks && peaks.length > 0) {
    const n = peaks.length;
    const bw = W / n;
    for (let k = 0; k < n; k++) {
      const a = Math.max(dpr * 0.75, Math.min(1, Math.max(0, peaks[k]!)) * H * 0.44);
      c.fillRect(k * bw, H / 2 - a, Math.max(dpr * 0.75, bw - 0.35 * dpr), a * 2);
    }
  } else {
    c.fillRect(0, H / 2 - dpr * 0.5, W, dpr);
  }
  c.globalAlpha = 0.55;
  for (const t of ticks) c.fillRect(Math.round(t * W), 0, Math.max(1, Math.round(dpr)), Math.round(5 * dpr));
  c.globalAlpha = 1;
}

export function Waveform({ label, peaks, durationSec, bpm, firstBeatSec, position, onSeek }: WaveformProps) {
  const host = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const lit = useRef<HTMLCanvasElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const litWrap = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const latest = useRef({ position, durationSec, onSeek });
  latest.current = { position, durationSec, onSeek };

  // drawn on size, theme and peaks
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ticks = downbeats({ bpm, firstBeatSec }, durationSec);
    const paint = () => {
      const w = el.clientWidth;
      if (base.current) draw(base.current, w, peaks, ticks, cssVar('--line-strong', '#999'));
      if (lit.current) draw(lit.current, w, peaks, ticks, cssVar('--dew', '#276a82'));
    };
    paint();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(paint) : null;
    ro?.observe(el);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(paint) : null;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', paint);
    return () => { ro?.disconnect(); mo?.disconnect(); mq?.removeEventListener?.('change', paint); };
  }, [peaks, bpm, firstBeatSec, durationSec]);

  // the playhead and the played part, each frame, by transform
  useEffect(() => {
    let raf = 0;
    let lastText = -1;
    const frame = () => {
      const { position: p, durationSec: d } = latest.current;
      const sec = p();
      const f = d && d > 0 ? Math.min(1, Math.max(0, sec / d)) : 0;
      if (clip.current) clip.current.style.transform = `translateX(${(f - 1) * 100}%)`;
      if (litWrap.current) litWrap.current.style.transform = `translateX(${(1 - f) * 100}%)`;
      if (head.current) head.current.style.transform = `translateX(${f * 100}%)`;
      const whole = Math.floor(sec);
      if (whole !== lastText && host.current) {
        lastText = whole;
        host.current.setAttribute('aria-valuenow', String(whole));
        host.current.setAttribute('aria-valuetext', `${deckClock(sec)} of ${deckClock(d ?? 0)}`);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seekAt = (clientX: number) => {
    const el = host.current;
    const d = latest.current.durationSec;
    if (!el || !d) return;
    const r = el.getBoundingClientRect();
    latest.current.onSeek(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * d);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !durationSec) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    dragging.current = true;
    seekAt(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => { if (dragging.current) seekAt(e.clientX); };
  const stop = () => { dragging.current = false; };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!durationSec) return;
    const step = bpm && bpm > 0 ? (4 * 60) / bpm : 5;
    const now = position();
    let to: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') to = now + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') to = now - step;
    else if (e.key === 'PageUp') to = now + step * 4;
    else if (e.key === 'PageDown') to = now - step * 4;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = durationSec - 1;
    if (to == null) return;
    e.preventDefault();
    e.stopPropagation();
    onSeek(Math.min(durationSec, Math.max(0, to)));
  };

  return (
    <div
      ref={host}
      className={styles.wave}
      role="slider"
      tabIndex={durationSec ? 0 : -1}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(durationSec ?? 0)}
      aria-valuenow={0}
      aria-disabled={!durationSec || undefined}
      data-measuring={peaks && peaks.length === 0 ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={onKeyDown}
    >
      <canvas ref={base} className={styles.canvas} aria-hidden="true" />
      <div ref={clip} className={styles.played} aria-hidden="true">
        <div ref={litWrap} className={styles.litWrap}>
          <canvas ref={lit} className={styles.canvas} />
        </div>
      </div>
      <div ref={head} className={styles.headRunner} aria-hidden="true"><span className={styles.head} /></div>
    </div>
  );
}
