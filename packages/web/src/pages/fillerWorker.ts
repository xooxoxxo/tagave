/**
 * Paints the short-album artwork (AlbumFiller) off the main thread. A
 * full-screen piece is tens of thousands of dots; painted on the page it held
 * the main thread for up to a second per paint, and a page could paint it
 * several times while settling (freeze hunt 2026-10-11).
 *
 * The page hands over the canvas once (transferControlToOffscreen) and then
 * sends the size, ink and title whenever they change. Messages that arrive
 * while a paint runs are folded into one paint of the latest.
 */
import { paintFiller } from './albumFlow';

export interface FillerJob {
  canvas?: OffscreenCanvas;
  w: number;
  h: number;
  dpr: number;
  ink: string;
  title: string;
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<FillerJob>) => void) | null };
let canvas: OffscreenCanvas | null = null;
let latest: FillerJob | null = null;
let scheduled = false;

function paint() {
  scheduled = false;
  const job = latest;
  latest = null;
  if (!job || !canvas || !job.w || !job.h) return;
  canvas.width = Math.round(job.w * job.dpr);
  canvas.height = Math.round(job.h * job.dpr);
  const g = canvas.getContext('2d');
  if (g) paintFiller(g, job.w, job.h, job.dpr, job.title, job.ink);
}

scope.onmessage = (e) => {
  if (e.data.canvas) canvas = e.data.canvas;
  latest = e.data;
  if (!scheduled) {
    scheduled = true;
    setTimeout(paint, 0);
  }
};
