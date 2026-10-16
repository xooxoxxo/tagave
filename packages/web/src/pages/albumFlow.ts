/**
 * The album page flow (vault spec "tagave - Album Page Flow", approved
 * prototype album-flow-prototype.html): the scroll-linked math and the
 * album details, kept free of the DOM so they can be tested.
 *
 * As the page scrolls: the cover fades in place (gone as its bottom passes
 * the header); the artist and album lines shrink with the page and reach
 * header size exactly as the artist line meets the header's lower edge, when
 * the header docks; TRACKLIST's caret straightens from the first scroll and
 * is a flat line by the time the label sticks under the header.
 */
import type { DetailTrack } from './albumDetailTypes';
import { totalLength } from './albumFormat';

/** the docked header's height (the keys' full height) */
export const HEADER = 64;
/** artist line: 17px at rest, 13px in the header */
export const A_REST = 17;
export const A_HDR = 13;
/** album line: 34px at rest, 17px in the header; it rests 23px below the artist line */
export const B_REST = 34;
export const B_HDR = 17;
export const B_TOP = 23;
/** the caret's drawing width (its viewBox; the svg stretches it across the label) */
export const CARET_W = 346;

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Where the moving parts sit in the scrolled page (px from the scroll area's top, at scroll 0). */
export interface FlowGeometry {
  /** the cover's bottom edge */
  coverBottom: number;
  /** the artist line's top edge */
  namesTop: number;
  /** TRACKLIST's top edge (in flow, before it sticks) */
  tlTop: number;
}

export interface FlowState {
  coverOpacity: number;
  /** 0 at rest, 1 when the artist line meets the header's lower edge */
  nameProgress: number;
  artistScale: number;
  albumScale: number;
  /** the album line's shift up toward the artist line (px, ≤ 0) */
  albumShift: number;
  docked: boolean;
  /** 0 a wide caret, 1 a flat separator (TRACKLIST stuck) */
  caretProgress: number;
}

export function flowState(y: number, geo: FlowGeometry, header = HEADER): FlowState {
  const coverOpacity = 1 - clamp01(y / Math.max(1, geo.coverBottom - header));
  const t = clamp01(y / Math.max(1, geo.namesTop - header));
  const albumTop = lerp(B_TOP, A_HDR * 1.2 + 1, t);
  return {
    coverOpacity,
    nameProgress: t,
    artistScale: lerp(1, A_HDR / A_REST, t),
    albumScale: lerp(1, B_HDR / B_REST, t),
    albumShift: albumTop - B_TOP,
    docked: t >= 1,
    caretProgress: clamp01(y / Math.max(1, geo.tlTop - header)),
  };
}

/** The caret under TRACKLIST: a wide shallow "v" that flattens into a line. */
export function caretPath(k: number, w = CARET_W): string {
  const p = clamp01(k);
  const mid = w / 2;
  const half = lerp(70, mid, p);
  const dip = lerp(12, 8, p);
  const edge = lerp(4, 8, p);
  const n = (v: number) => Math.round(v * 100) / 100;
  return `M${n(mid - half)} ${n(edge)} L${n(mid)} ${n(dip)} L${n(mid + half)} ${n(edge)}`;
}

/* ---------------- short albums: the generative filler ---------------- */

/** Albums with this many tracks or fewer get the generative piece under the tracklist. */
export const FILLER_MAX_TRACKS = 3;
export const FILLER_MIN_HEIGHT = 320;

export const wantsFiller = (trackCount: number) => trackCount <= FILLER_MAX_TRACKS;

/** The filler fills the screen under the stuck header and TRACKLIST (never less than 320px). */
export function fillerHeight(viewport: number, tlHeight: number, tracksHeight: number, header = HEADER): number {
  return Math.max(Math.max(0, viewport - header - tlHeight - tracksHeight), FILLER_MIN_HEIGHT);
}

/** A repeatable random stream from a string: FNV-1a seed, xorshift steps, values in [0, 1). */
export function seededRandom(str: string): () => number {
  let h = 2166136261;
  for (const c of str) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

export interface RippleCentre { x: number; y: number; r: number; f: number }

/** The ripple sources for a title: 3 to 5 of them, placed inside the piece. */
export function fillerCentres(title: string, w: number, h: number): RippleCentre[] {
  const rnd = seededRandom(title);
  return Array.from({ length: 3 + Math.floor(rnd() * 3) }, () => ({
    x: w * (0.15 + rnd() * 0.7),
    y: h * (0.25 + rnd() * 0.6),
    r: 40 + rnd() * 90,
    f: 0.6 + rnd() * 1.2,
  }));
}

export function rippleField(centres: readonly RippleCentre[], x: number, y: number): number {
  let s = 0;
  for (const c of centres) {
    const d = Math.hypot(x - c.x, y - c.y);
    s += Math.sin(d / (14 * c.f)) * Math.exp(-d / (c.r * 2.4));
  }
  return s;
}

/**
 * The contour dots of the piece: [x, y, alpha] in CSS px, grouped by contour
 * level. Same title, same piece. The field is sampled once on the 3px grid and
 * every level is read from those samples: evaluating it again per level made
 * a full-screen piece cost about a second of main thread (freeze hunt
 * 2026-10-11).
 */
export function fillerDots(title: string, w: number, h: number): Array<[number, number, number]> {
  const centres = fillerCentres(title, w, h);
  const xs: number[] = [0];
  for (let x = 3; x < w; x += 3) xs.push(x);
  const ys: number[] = [];
  for (let y = 0; y < h; y += 3) ys.push(y);
  const field = new Float64Array(xs.length * ys.length);
  for (let j = 0; j < ys.length; j++) {
    for (let i = 0; i < xs.length; i++) field[j * xs.length + i] = rippleField(centres, xs[i]!, ys[j]!);
  }
  const dots: Array<[number, number, number]> = [];
  for (let l = 0; l <= 6; l++) {
    const level = -0.6 + l * 0.2;
    const alpha = 0.10 + 0.22 * (1 - Math.abs(level) / 0.6);
    for (let j = 0; j < ys.length; j++) {
      const row = j * xs.length;
      let prev = field[row]! - level;
      for (let i = 1; i < xs.length; i++) {
        const v = field[row + i]! - level;
        if ((v > 0) !== (prev > 0)) dots.push([xs[i]!, ys[j]!, alpha]);
        prev = v;
      }
    }
  }
  return dots;
}

/** A 2D context on the page or in a worker (OffscreenCanvas): the piece paints the same on both. */
export type FillerContext = Pick<CanvasRenderingContext2D,
  'setTransform' | 'clearRect' | 'fillStyle' | 'globalAlpha' | 'globalCompositeOperation' | 'beginPath' | 'moveTo' | 'arc' | 'fill' | 'createLinearGradient' | 'fillRect'>;

/** The device pixel ratio the piece is painted at (capped: more is not visible in a decoration). */
export const fillerDpr = (ratio: number | undefined) => Math.min(2, ratio || 1);

/**
 * Paint the piece on a context already sized to w x h CSS px at dpr: ripple
 * contours in the accent colour, fading in from the tracklist above. The dots
 * of one level share their alpha and never touch (3px apart, 0.9px radius),
 * so each level is one path and one fill.
 */
export function paintFiller(g: FillerContext, w: number, h: number, dpr: number, title: string, ink: string): void {
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = ink;
  // a level's dots come in reading order: a new alpha, or a step back, starts the next level
  let alpha = -1, px = -1, py = -1;
  for (const [x, y, a] of fillerDots(title, w, h)) {
    if (a !== alpha || y < py || (y === py && x <= px)) {
      if (alpha >= 0) g.fill();
      alpha = a;
      g.globalAlpha = a;
      g.beginPath();
    }
    px = x; py = y;
    g.moveTo(x + 0.9, y);
    g.arc(x, y, 0.9, 0, Math.PI * 2);
  }
  if (alpha >= 0) g.fill();
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'destination-out';
  const grad = g.createLinearGradient(0, 0, 0, 110);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, 110);
  g.globalCompositeOperation = 'source-over';
}

/** Paint the piece on a canvas on the page, sized to its box (the fallback when no worker can). */
export function drawFiller(canvas: HTMLCanvasElement, title: string, ink: string): void {
  const dpr = fillerDpr(globalThis.devicePixelRatio);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  if (!g) return;
  paintFiller(g, w, h, dpr, title, ink);
}

/* ---------------- the album's details ---------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2002-09-24" → "24 Sep 2002"; "2002-09" → "Sep 2002"; "2002" stays. */
export function formatReleased(date: string | null | undefined, year?: number | null): string | null {
  const m = (date ?? '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return year ? String(year) : null;
  const [, y, mo, d] = m;
  const month = mo ? MONTHS[Number(mo) - 1] : undefined;
  if (month && d) return `${Number(d)} ${month} ${y}`;
  if (month) return `${month} ${y}`;
  return y ?? null;
}

const AREA_NAMES: Record<string, string> = { XW: 'Worldwide', XE: 'Europe', XU: 'Unknown' };

/** A release country code ("US", "XE") as a name; anything else as given. */
export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.trim();
  if (AREA_NAMES[c.toUpperCase()]) return AREA_NAMES[c.toUpperCase()]!;
  if (/^[A-Za-z]{2}$/.test(c)) {
    try {
      return new Intl.DisplayNames(['en'], { type: 'region' }).of(c.toUpperCase()) ?? c;
    } catch {
      return c;
    }
  }
  return c;
}

/** "FLAC · 16-bit / 44.1 kHz", "MP3 · 320 kbps", or the codecs when the files differ. */
export function formatLine(tracks: readonly DetailTrack[], formats: readonly string[] | null | undefined): string | null {
  const codecs = [...new Set(tracks.map((t) => t.file.codec).filter((c): c is string => !!c))];
  const names = codecs.length ? codecs : [...(formats ?? [])];
  if (names.length === 0) return null;
  if (names.length > 1 || tracks.length === 0) return names.join(' · ');
  const one = <T,>(values: T[]) => (new Set(values).size === 1 ? values[0] : undefined);
  const lossless = one(tracks.map((t) => !!t.file.lossless));
  if (lossless) {
    const depth = one(tracks.map((t) => t.file.bitDepth));
    const rate = one(tracks.map((t) => t.file.sampleRate));
    if (depth && rate) return `${names[0]} · ${depth}-bit / ${Number((rate / 1000).toFixed(1))} kHz`;
    return names[0]!;
  }
  const kbps = one(tracks.map((t) => t.file.bitrateKbps));
  return kbps ? `${names[0]} · ${kbps} kbps` : names[0]!;
}

export interface AlbumFactsInput {
  date: string | null | undefined;
  year: number | null | undefined;
  labels: Array<{ name: string; catno?: string | undefined }> | null | undefined;
  country: string | null | undefined;
  totalDurationMs: number | null | undefined;
  trackCount: number | null | undefined;
  discCount: number | null | undefined;
  isCueImage: boolean;
  formats: readonly string[] | null | undefined;
  tracks: readonly DetailTrack[];
}

/** Short codec names for the line under the album ("MPEG 1 Layer 3" reads as MP3). */
const SHORT_CODEC: Record<string, string> = {
  'MPEG 1 Layer 3': 'MP3', 'MPEG 2 Layer 3': 'MP3', 'MPEG 2.5 Layer 3': 'MP3', 'MPEG 1 Layer 2': 'MP2',
  'MPEG-4/AAC': 'AAC', 'MPEG-4/AAC+MP4S': 'AAC', 'Vorbis I': 'Vorbis', 'DSD (not compressed)': 'DSD',
};
const shortCodec = (c: string) => SHORT_CODEC[c] ?? c;

/** "MP3 320 kbps", "FLAC 24-bit/96 kHz", or the codecs when the files differ: one short, unbreakable value. */
export function shortFormat(tracks: readonly DetailTrack[], formats: readonly string[] | null | undefined): string | null {
  const codecs = [...new Set(tracks.map((t) => t.file.codec).filter((c): c is string => !!c).map(shortCodec))];
  const names = codecs.length ? codecs : [...new Set((formats ?? []).map((f) => shortCodec(f.toUpperCase() === f ? f : f.toUpperCase())))];
  if (names.length === 0) return null;
  if (names.length > 1 || tracks.length === 0) return names.join(' / ');
  const one = <T,>(values: T[]) => (new Set(values).size === 1 ? values[0] : undefined);
  if (one(tracks.map((t) => !!t.file.lossless))) {
    const depth = one(tracks.map((t) => t.file.bitDepth));
    const rate = one(tracks.map((t) => t.file.sampleRate));
    return depth && rate ? `${names[0]} ${depth}-bit/${Number((rate / 1000).toFixed(1))} kHz` : names[0]!;
  }
  const kbps = one(tracks.map((t) => t.file.bitrateKbps));
  return kbps ? `${names[0]} ${kbps} kbps` : names[0]!;
}

/**
 * The album's details as two quiet lines under the names (the owner found
 * the labelled grid took too much room, 2026-10-15): when and who
 * ("2012 · Frontiers Records"), then what ("1 hr 58 min · 22 tracks ·
 * 2 discs · MP3 320 kbps"). Each value is one unbreakable piece; the full
 * date, country and catalogue numbers stay in About.
 */
export function albumSummary(a: AlbumFactsInput): { when: string[]; what: string[] } {
  const year = (a.date ?? '').match(/^(\d{4})/)?.[1] ?? (a.year ? String(a.year) : null);
  const labelNames = [...new Set((a.labels ?? []).map((l) => l.name).filter(Boolean))];
  const labels = labelNames.length > 2 ? `${labelNames.slice(0, 2).join(', ')} +${labelNames.length - 2}` : labelNames.join(', ');
  const count = a.trackCount == null ? null : a.isCueImage
    ? `${a.trackCount} audio ${a.trackCount === 1 ? 'file' : 'files'}`
    : `${a.trackCount} ${a.trackCount === 1 ? 'track' : 'tracks'}`;
  return {
    when: [year, labels || null].filter((v): v is string => !!v),
    what: [totalLength(a.totalDurationMs), count, (a.discCount ?? 1) > 1 ? `${a.discCount} discs` : null, shortFormat(a.tracks, a.formats)]
      .filter((v): v is string => !!v),
  };
}
