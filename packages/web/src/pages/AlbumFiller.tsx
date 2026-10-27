/**
 * Short albums (≤ 5 tracks): a generative piece under the tracklist, ripple
 * contours in the accent colour seeded by the album title (same title, same
 * piece), fading in from the tracklist. Decoration only: no text, hidden
 * from assistive technology. Redrawn when its size or the theme changes, and
 * only then: a render that leaves both alone keeps the piece on the canvas.
 * Shorter than FILLER_MIN_HEIGHT it shows and paints nothing (no sliver).
 *
 * Painted in a worker (fillerWorker.ts) where the browser can hand the canvas
 * over; a full-screen piece took up to a second of main thread per paint.
 * Elsewhere it paints on the page as before.
 */
import { useEffect, useRef } from 'react';
import { drawFiller, fillerDpr, FILLER_MIN_HEIGHT } from './albumFlow';
import type { FillerJob } from './fillerWorker';
import styles from './AlbumDetailPage.module.css';

/** The worker painting each canvas: a canvas can be handed over only once, so it stays with it. */
const painters = new WeakMap<HTMLCanvasElement, Worker>();
/** Canvases handed to a worker: the page can no longer draw on them. */
const handedOver = new WeakSet<HTMLCanvasElement>();

function painterFor(cv: HTMLCanvasElement): Worker | null {
  const known = painters.get(cv);
  if (known) return known;
  if (typeof Worker === 'undefined' || typeof cv.transferControlToOffscreen !== 'function') return null;
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./fillerWorker.ts', import.meta.url), { type: 'module' });
    const offscreen = cv.transferControlToOffscreen();
    handedOver.add(cv);
    worker.postMessage({ canvas: offscreen, w: 0, h: 0, dpr: 1, ink: '', title: '' } satisfies FillerJob, [offscreen]);
    painters.set(cv, worker);
    return worker;
  } catch {
    worker?.terminate();
    return null;
  }
}

/**
 * Keep a canvas painted with the piece for a title: paints now, again when its
 * size or the theme changes, never twice for the same size, ink and title
 * (`painted` remembers what is on it across re-runs). Returns the cleanup.
 */
export function attachFiller(cv: HTMLCanvasElement, title: string, painted: { current: string }): () => void {
  const worker = painterFor(cv);
  const paint = () => {
    const ink = getComputedStyle(cv).getPropertyValue('--dew').trim() || '#276a82';
    const w = cv.clientWidth, h = cv.clientHeight, dpr = fillerDpr(globalThis.devicePixelRatio);
    // too little room for the piece: keep the room, show nothing (CSS: .filler[data-thin])
    const thin = h < FILLER_MIN_HEIGHT;
    cv.toggleAttribute?.('data-thin', thin);
    if (thin) return;
    const key = `${w}x${h}@${dpr} ${ink} ${title}`;
    if (key === painted.current) return;
    painted.current = key;
    if (worker) worker.postMessage({ w, h, dpr, ink, title } satisfies FillerJob);
    else if (!handedOver.has(cv)) drawFiller(cv, title, ink);
  };
  paint();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(paint) : null;
  ro?.observe(cv);
  const scheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  scheme?.addEventListener('change', paint);
  const themeWatch = typeof MutationObserver !== 'undefined' ? new MutationObserver(paint) : null;
  themeWatch?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    ro?.disconnect();
    scheme?.removeEventListener('change', paint);
    themeWatch?.disconnect();
    // the canvas leaving the page ends its worker; a re-run (new height, StrictMode) keeps it
    if (worker) {
      setTimeout(() => {
        if (!cv.isConnected && painters.get(cv) === worker) {
          worker.terminate();
          painters.delete(cv);
        }
      }, 0);
    }
  };
}

/** Its height is the room the pane has left under the tracks (CSS: .flow and .filler), never more. */
export function AlbumFiller({ title }: { title: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  /** what is on the canvas now: size, density, ink and title */
  const painted = useRef('');
  useEffect(() => {
    const cv = ref.current;
    return cv ? attachFiller(cv, title, painted) : undefined;
  }, [title]);
  return <canvas ref={ref} className={styles.filler} aria-hidden="true" data-album-filler="" />;
}
