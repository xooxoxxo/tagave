/**
 * Paints the update's glyph off the main thread (as fillerWorker.ts does the
 * short albums'): the page hands the canvas over once, then sends the params
 * whenever they change; the lamp's frame loop runs here. `{ stats: true }`
 * answers with the recent paint times.
 */
import { GlyphPainter, type GlyphParams } from './glyphPaint';

export type GlyphMessage = { canvas: OffscreenCanvas } | { params: GlyphParams } | { stats: true } | { stop: true };

const scope = self as unknown as { onmessage: ((e: MessageEvent<GlyphMessage>) => void) | null; postMessage: (m: unknown) => void };
let painter: GlyphPainter | null = null;

scope.onmessage = (e) => {
  const m = e.data;
  if ('canvas' in m) painter = new GlyphPainter(m.canvas, true);
  else if ('params' in m) painter?.update(m.params);
  else if ('stats' in m) scope.postMessage({ costs: painter ? [...painter.costs] : [] });
  else if ('stop' in m) painter?.stop();
};
