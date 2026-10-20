/**
 * The update's glyph: the short albums' dotted contours (albumFlow.ts: the
 * 3px grid, 0.9px dots, the accent colour) drawn around slow blobs like the
 * wax in a lava lamp. The blobs are seeded by the version the update goes to
 * (same version, same piece); each drifts on its own slow loop (tens of
 * seconds) and swells and shrinks, so nested contours merge and part. They
 * grow with the run's progress. Pure painting, the progress model and the
 * frame loop; the canvas, its worker and the page are in UpdateGlyph.tsx and
 * glyphWorker.ts.
 */
import type { UpdateRun, UpdateStepId } from '@tagave/shared';
import { seededRandom } from '../../pages/albumFlow';

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

/** A blob: where it rests, how far and how slowly it drifts (s per loop), how big it is and how it swells. */
export interface LavaBlob { bx: number; by: number; ax: number; ay: number; px: number; py: number; fx: number; fy: number; r: number; pr: number; fr: number }

/** The blobs for a version in a w x h piece: 4 to 6, sized to the piece. */
export function lavaBlobs(seed: string, w: number, h: number): LavaBlob[] {
  const rnd = seededRandom(`lava:${seed}`);
  const scale = Math.max(0.6, Math.min(2.4, Math.min(w, h) / 300));
  const tau = Math.PI * 2;
  return Array.from({ length: 4 + Math.floor(rnd() * 3) }, () => ({
    bx: w * (0.18 + rnd() * 0.64),
    by: h * (0.22 + rnd() * 0.56),
    ax: w * (0.05 + rnd() * 0.1),
    ay: h * (0.1 + rnd() * 0.18),
    px: 28 + rnd() * 36,
    py: 22 + rnd() * 30,
    fx: rnd() * tau,
    fy: rnd() * tau,
    r: (30 + rnd() * 46) * scale,
    pr: 16 + rnd() * 20,
    fr: rnd() * tau,
  }));
}

/** The contour levels of the blobs' field, outermost first. */
const LEVELS = [0.42, 0.58, 0.8, 1.08, 1.45, 1.95, 2.7];

export interface GlyphFrame {
  w: number;
  h: number;
  dpr: number;
  seed: string;
  ink: string;
  /** 0 to 1: how big the blobs have grown */
  progress: number;
  /** seconds on the lamp's clock */
  time: number;
  /** how strong the dots are (1: the album filler's) */
  strength?: number;
  /** the grid, in CSS px (3: the filler's) */
  step?: number;
}

/**
 * Paint one frame on a context sized to w x h CSS px at dpr: the field
 * Σ r² / d² of the blobs where they are at `time`, its contours as dots
 * (a dot where the field crosses a level against its left or upper
 * neighbour), the inner levels stronger, faded at the edges. Dots are
 * bucketed by alpha so each bucket is one path and one fill.
 */
export function paintGlyph(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, f: GlyphFrame): void {
  const { w, h, dpr, seed, ink, time } = f;
  const step = f.step ?? 3;
  const strength = f.strength ?? 1;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (w <= 0 || h <= 0) return;
  const tau = Math.PI * 2;
  const grow = 0.5 + 0.5 * Math.max(0, Math.min(1, f.progress));
  const blobs = lavaBlobs(seed, w, h).map((b) => {
    const r = b.r * grow * (1 + 0.24 * Math.sin((tau * time) / b.pr + b.fr));
    return { x: b.bx + b.ax * Math.sin((tau * time) / b.px + b.fx), y: b.by + b.ay * Math.sin((tau * time) / b.py + b.fy), r2: r * r };
  });
  const cols = Math.ceil(w / step), rows = Math.ceil(h / step);
  const field = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const y = j * step;
    for (let i = 0; i < cols; i++) {
      const x = i * step;
      let s = 0;
      for (const b of blobs) {
        const dx = x - b.x, dy = y - b.y;
        s += b.r2 / (dx * dx + dy * dy + 1);
      }
      field[j * cols + i] = s;
    }
  }
  const fade = Math.min(32, Math.min(w, h) * 0.12);
  const buckets = new Map<number, Path2D>();
  for (let l = 0; l < LEVELS.length; l++) {
    const level = LEVELS[l]!;
    const base = (0.09 + 0.045 * l) * strength;
    for (let j = 0; j < rows; j++) {
      const y = j * step;
      const row = j * cols;
      for (let i = 0; i < cols; i++) {
        const v = field[row + i]! > level;
        const left = i > 0 && (field[row + i - 1]! > level) !== v;
        const up = j > 0 && (field[row - cols + i]! > level) !== v;
        if (!left && !up) continue;
        const x = i * step;
        const border = Math.min(1, Math.min(x, y, w - x, h - y) / fade);
        const a = Math.round(Math.min(0.9, base * border) * 32) / 32;
        if (a <= 0) continue;
        let p = buckets.get(a);
        if (!p) buckets.set(a, (p = new Path2D()));
        p.moveTo(x + 0.9, y);
        p.arc(x, y, 0.9, 0, tau);
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

/** What the page tells the painter; everything but the canvas may change at any time. */
export interface GlyphParams {
  w: number;
  h: number;
  dpr: number;
  seed: string;
  ink: string;
  strength: number;
  step: number;
  /** where the run is, 0 to 1; the glyph eases toward it */
  progress: number;
  /** the lamp runs (a running update, motion allowed, the tab visible) */
  moving: boolean;
  /** a fixed clock: one still frame at this time (stories, reduced motion) */
  time: number | null;
}

/** Frames a second at most: the motion is slow, more buys nothing. */
export const GLYPH_FPS = 30;

/** Where a lamp's clock starts, so two versions do not start on the same frame. */
export const seedTime = (seed: string) => seededRandom(`t:${seed}`)() * 600;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * The frame loop, the same on the page and in a worker: paints when the
 * params change; while `moving`, at most GLYPH_FPS frames a second on the
 * lamp's clock, easing the size toward the progress. Stopped, the clock
 * stays where it was (a finished run settles where it stopped). Keeps the
 * paint times for a look at what it costs.
 */
export class GlyphPainter {
  private params: GlyphParams | null = null;
  private shown = 0;
  private clock = 0;
  private last = 0;
  private timer: ReturnType<typeof setTimeout> | number | null = null;
  readonly costs: number[] = [];

  constructor(private readonly canvas: HTMLCanvasElement | OffscreenCanvas, private readonly sized: boolean) {}

  update(next: GlyphParams): void {
    const first = !this.params;
    if (first || this.params!.seed !== next.seed) this.clock = seedTime(next.seed);
    if (first || next.time !== null) this.shown = next.progress;
    this.params = next;
    this.paint();
    this.schedule();
  }

  stop(): void {
    this.cancel();
    this.params = null;
  }

  private cancel(): void {
    if (this.timer === null) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.timer as number);
    clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
  }

  private schedule(): void {
    const p = this.params;
    const settling = p && Math.abs(p.progress - this.shown) > 0.002;
    if (!p || p.time !== null || (!p.moving && !settling)) { this.cancel(); this.last = 0; return; }
    if (this.timer !== null) return;
    const next = (t: number) => {
      this.timer = null;
      const q = this.params;
      if (!q) return;
      if (this.last && t - this.last < 1000 / GLYPH_FPS - 2) { this.schedule(); return; }
      const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
      this.last = t;
      if (q.moving) this.clock += dt;
      this.shown += (q.progress - this.shown) * Math.min(1, dt * 0.8);
      this.paint();
      this.schedule();
    };
    this.timer = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(next)
      : setTimeout(() => next(performance.now()), 1000 / GLYPH_FPS);
  }

  private paint(): void {
    const p = this.params;
    if (!p || !p.w || !p.h) return;
    const started = performance.now();
    const pw = Math.round(p.w * p.dpr), ph = Math.round(p.h * p.dpr);
    if (!this.sized || this.canvas.width !== pw) this.canvas.width = pw;
    if (!this.sized || this.canvas.height !== ph) this.canvas.height = ph;
    const g = this.canvas.getContext('2d') as Ctx | null;
    if (!g) return;
    paintGlyph(g, { w: p.w, h: p.h, dpr: p.dpr, seed: p.seed, ink: p.ink, progress: this.shown, time: p.time ?? this.clock, strength: p.strength, step: p.step });
    this.costs.push(performance.now() - started);
    if (this.costs.length > 240) this.costs.shift();
  }
}
