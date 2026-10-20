/**
 * The update's glyph: the short albums' ripple contours (albumFlow.ts),
 * seeded by the version the update goes to (same version, same piece), that
 * grow out from the piece's centre as the run moves on and drift outward
 * slowly while it runs. Pure painting and the progress model; the canvas and
 * its clock are in UpdateGlyph.tsx.
 */
import type { UpdateRun, UpdateStepId } from '@tagave/shared';
import { fillerCentres, type RippleCentre } from '../../pages/albumFlow';

/** Each step's share of the run, and about how long it takes (s): how far the glyph has grown. */
const STEP_SHARE: Partial<Record<UpdateStepId, { share: number; typical: number }>> = {
  preflight: { share: 0.34, typical: 40 },
  backup: { share: 0.06, typical: 4 },
  config: { share: 0.04, typical: 2 },
  pull: { share: 0.06, typical: 3 },
  restart: { share: 0.38, typical: 30 },
  verify: { share: 0.12, typical: 8 },
};

/**
 * How far along the run is, 0 to 1: the shares of the done steps, and of the
 * running one the part its typical length says (never all of it: a slow step
 * holds just short of its end). A success is 1; any other end stays where it
 * stopped.
 */
export function runProgress(run: UpdateRun, now: number): number {
  if (run.status === 'succeeded') return 1;
  let p = 0;
  for (const s of run.steps) {
    const w = STEP_SHARE[s.id];
    if (!w) continue;
    if (s.status === 'done' || s.status === 'skipped') p += w.share;
    else if (s.status === 'running' || s.status === 'failed') {
      const end = s.finishedAt ? Date.parse(s.finishedAt) : now;
      const t = s.startedAt ? Math.max(0, (end - Date.parse(s.startedAt)) / 1000) : 0;
      p += w.share * Math.min(0.9, t / w.typical);
    }
  }
  return Math.max(0, Math.min(1, p));
}

function field(centres: readonly RippleCentre[], x: number, y: number, phase: number): number {
  let s = 0;
  for (const c of centres) {
    const d = Math.hypot(x - c.x, y - c.y);
    s += Math.sin(d / (14 * c.f) - phase) * Math.exp(-d / (c.r * 2.4));
  }
  return s;
}

export interface GlyphFrame {
  w: number;
  h: number;
  dpr: number;
  seed: string;
  ink: string;
  /** 0 to 1: how far out from the centre the contours reach */
  reach: number;
  /** radians the ripples have drifted outward */
  phase: number;
  /** how strong the dots are (1: the album filler's; the hero piece runs stronger) */
  strength?: number;
  /** the 3px grid of the filler, or wider for a small piece */
  step?: number;
}

/**
 * Paint one frame on a context sized to w x h CSS px at dpr: the contour dots
 * of 7 levels, each faded by how far it is past the reach and by the edges.
 * Dots are bucketed by alpha so each bucket is one path and one fill.
 */
export function paintGlyph(g: CanvasRenderingContext2D, f: GlyphFrame): void {
  const { w, h, dpr, seed, ink, reach, phase } = f;
  const step = f.step ?? 3;
  const strength = f.strength ?? 1;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (w <= 0 || h <= 0) return;
  const centres = fillerCentres(seed, w, h);
  const cx = centres.reduce((a, c) => a + c.x, 0) / centres.length;
  const cy = centres.reduce((a, c) => a + c.y, 0) / centres.length;
  const far = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
  const r = Math.max(0, Math.min(1, reach));
  const soft = Math.max(24, far * 0.3);
  // at 1 the soft edge is past the farthest corner: the whole piece shows
  const radius = soft + (far + 4) * (0.12 + 0.88 * r);
  const xs: number[] = [];
  for (let x = 0; x < w; x += step) xs.push(x);
  const ys: number[] = [];
  for (let y = 0; y < h; y += step) ys.push(y);
  const vals = new Float64Array(xs.length * ys.length);
  for (let j = 0; j < ys.length; j++) for (let i = 0; i < xs.length; i++) vals[j * xs.length + i] = field(centres, xs[i]!, ys[j]!, phase);
  const buckets = new Map<number, Path2D>();
  const fade = Math.min(28, Math.min(w, h) * 0.12);
  for (let l = 0; l <= 6; l++) {
    const level = -0.6 + l * 0.2;
    const base = (0.10 + 0.22 * (1 - Math.abs(level) / 0.6)) * strength;
    for (let j = 0; j < ys.length; j++) {
      const row = j * xs.length;
      const y = ys[j]!;
      let prev = vals[row]! - level;
      for (let i = 1; i < xs.length; i++) {
        const v = vals[row + i]! - level;
        if ((v > 0) !== (prev > 0)) {
          const x = xs[i]!;
          const d = Math.hypot(x - cx, y - cy);
          const grow = d <= radius - soft ? 1 : d >= radius ? 0 : (radius - d) / soft;
          const border = Math.min(1, Math.min(x, y, w - x, h - y) / fade);
          const a = Math.round(Math.min(0.9, base * grow * grow * border) * 32) / 32;
          if (a > 0) {
            let p = buckets.get(a);
            if (!p) buckets.set(a, (p = new Path2D()));
            p.moveTo(x + 0.9, y);
            p.arc(x, y, 0.9, 0, Math.PI * 2);
          }
        }
        prev = v;
      }
    }
  }
  g.fillStyle = ink;
  for (const [a, p] of buckets) {
    g.globalAlpha = a;
    g.fill(p);
  }
  g.globalAlpha = 1;
}
