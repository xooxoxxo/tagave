/**
 * Two equalizer glows for the bottom of the window (rr55, branch-local
 * previews; nothing in the app imports this folder). Both rise from the
 * player bar's top edge, behind the page (the page's content paints over
 * them, the bar's surface and inks are untouched), in the glow colour the
 * seek bar uses (--seek-glow: the cover's under Adaptive, the theme's
 * otherwise), driven by the spectrum (lows in the middle, highs at the
 * ends, as a fire burns hottest in its middle).
 *
 * Hearth: a canvas of narrow tongues, one per ~28px, each a soft half
 *   ellipse whose height follows its band and flickers on its own, blurred
 *   together; additive on dark, a haze on light.
 * Horizon: seven wide lobes (CSS, transform and opacity only) that swell
 *   with their band group, slower to fall: a neon horizon breathing with the
 *   music rather than a fire.
 */
import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { BANDS, useSpectrum } from './spectrum';
import s from './glows.module.css';

function isDark(): boolean {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr) return attr === 'dark';
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** `rgb(r, g, b)` of a CSS colour, through a canvas. */
function rgbOf(colour: string): [number, number, number] {
  const g = document.createElement('canvas').getContext('2d')!;
  g.fillStyle = '#000';
  g.fillStyle = colour;
  const v = g.fillStyle;
  if (v.startsWith('#')) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
  const m = v.match(/[\d.]+/g) ?? ['0', '0', '0'];
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

function hash(n: number): number {
  const x = Math.sin(n * 91.3 + 17.1) * 43758.5453;
  return x - Math.floor(x);
}
function flicker(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

/** Band for a place along the width (0..1): lows in the middle, highs at the ends. */
const bandAt = (x: number) => Math.min(BANDS - 1, Math.floor(Math.abs(x - 0.5) * 2 * BANDS));

/** The canvas is painted at half resolution: it is blurred anyway. */
const SCALE = 0.5;

export function Hearth({ time }: { time?: number | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const look = useRef({ rgb: [91, 168, 196] as [number, number, number], dark: true, w: 0, h: 0 });
  // the last frame's input: a resize clears the canvas, so it is painted again
  const last = useRef<{ bands: Float32Array; t: number } | null>(null);

  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const size = () => {
      const w = Math.max(1, Math.round(cv.clientWidth * SCALE));
      const h = Math.max(1, Math.round(cv.clientHeight * SCALE));
      if (cv.width !== w) cv.width = w;
      if (cv.height !== h) cv.height = h;
      look.current.w = w;
      look.current.h = h;
      look.current.rgb = rgbOf(getComputedStyle(cv).getPropertyValue('--seek-glow').trim() || '#5ba8c4');
      look.current.dark = isDark();
      if (last.current) paintRef.current(last.current.bands, last.current.t);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(cv);
    const mo = new MutationObserver(size);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, []);

  const paint = (bands: Float32Array, t: number) => {
    last.current = { bands, t };
    const cv = ref.current;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const { w, h, rgb, dark } = look.current;
    const [r, gr, b] = rgb;
    const col = (a: number) => `rgba(${r},${gr},${b},${a})`;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    const peak = dark ? 0.55 : 0.32;
    // the embers' bed along the bar
    let lows = 0;
    for (let k = 0; k < 6; k++) lows += bands[k]!;
    lows /= 6;
    const bed = g.createLinearGradient(0, h, 0, h * 0.55);
    bed.addColorStop(0, col(peak * (0.45 + 0.4 * lows)));
    bed.addColorStop(1, col(0));
    g.fillStyle = bed;
    g.fillRect(0, h * 0.55, w, h * 0.45);
    // the tongues
    const n = Math.max(10, Math.round(w / (20 * SCALE)));
    const tw = (w / n) * 1.5;
    const still = time !== undefined || reduce;
    const tongue = (x: number, width: number, height: number, a: number) => {
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      grad.addColorStop(0, col(a));
      grad.addColorStop(0.5, col(a * 0.5));
      grad.addColorStop(1, col(0));
      g.save();
      g.translate(x, h);
      g.scale(width / 2, height);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(0, 0, 1, Math.PI, Math.PI * 2);
      g.fill();
      g.restore();
    };
    for (let i = 0; i < n; i++) {
      const x0 = (i + 0.5) / n;
      const d = Math.abs(x0 - 0.5) * 2;
      const e = bands[bandAt(x0)]!;
      // each tongue its own size, and its own flicker on top of its band
      const own = 0.7 + 0.6 * hash(i * 3.7);
      const f = still ? 0.6 : flicker(t * 6 + i * 1.93);
      const th = Math.min(h, h * (0.1 + 1.1 * Math.pow(e, 1.15) * (0.55 + 0.45 * f) * own) * (1 - 0.4 * d));
      const x = x0 * w + (still ? 0 : Math.sin(t * 1.7 + i * 2.1) * tw * 0.15);
      const a = peak * (0.45 + 0.55 * e);
      tongue(x, tw, th, a);
      // the hotter core: narrower, lower, stronger
      tongue(x, tw * 0.45, th * 0.55, Math.min(1, a * 1.3));
    }
  };
  const paintRef = useRef(paint);
  paintRef.current = paint;
  const reduce = useSpectrum(paint, time);

  return <canvas ref={ref} className={s.hearth} aria-hidden="true" data-reduced={reduce ? '' : undefined} />;
}

const LOBES = 7;

export function Horizon({ time }: { time?: number | undefined }) {
  const lobes = useRef<Array<HTMLSpanElement | null>>([]);
  const bed = useRef<HTMLSpanElement>(null);
  const held = useRef(new Float32Array(LOBES));

  useSpectrum((bands) => {
    const hold = held.current;
    let total = 0;
    for (let j = 0; j < LOBES; j++) {
      const x0 = (j + 0.5) / LOBES;
      // the lobe's band group: its band and the next two
      const b0 = bandAt(x0);
      let e = 0;
      for (let k = 0; k < 3; k++) e += bands[Math.min(BANDS - 1, b0 + k)]!;
      e /= 3;
      // slower to fall than the bands: it breathes rather than flickers
      hold[j] = e > hold[j]! ? e : hold[j]! + (e - hold[j]!) * 0.06;
      total += hold[j]!;
      const el = lobes.current[j];
      if (el) {
        el.style.transform = `translateX(-50%) scaleY(${(0.3 + 0.9 * hold[j]!).toFixed(3)})`;
        el.style.opacity = (0.4 + 0.6 * hold[j]!).toFixed(3);
      }
    }
    if (bed.current) bed.current.style.opacity = (0.5 + 0.5 * (total / LOBES)).toFixed(3);
  }, time);

  return (
    <div className={s.horizon} aria-hidden="true">
      <span ref={bed} className={s.horizonBed} />
      {Array.from({ length: LOBES }, (_, j) => (
        <span
          key={j}
          ref={(el) => { lobes.current[j] = el; }}
          className={s.lobe}
          style={{ left: `${((j + 0.5) / LOBES) * 100}%` } as CSSProperties}
        />
      ))}
    </div>
  );
}
