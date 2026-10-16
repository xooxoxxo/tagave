import { useEffect, useState, type ReactNode } from 'react';
import styles from './CoverArt.module.css';

export type CoverChipTone = 'neutral' | 'accent' | 'warn';

export interface CoverArtProps {
  /** Image URL; without one the refined placeholder is drawn. */
  src?: string | null | undefined;
  /** Album title: the placeholder's initials and the image's tilt come from it. */
  title: string;
  /** Alt text for the image. Defaults to empty: the title is printed beside the cover. */
  alt?: string;
  /** Faded and desaturated: an album you do not have (missing) or chose to skip. */
  dimmed?: 'missing' | 'ignored' | undefined;
  /** Tiny thumbnail: no initials, only the tinted field and the groove mark. */
  compact?: boolean;
  /** Fill a parent that already sets the size, instead of drawing a square. */
  fill?: boolean;
  loading?: 'lazy' | 'eager';
  /** Part of a card that reacts to hover: the art eases in a touch inside the
      clipped square and the shadow deepens (CoverArt.module.css). */
  interactive?: boolean;
  className?: string | undefined;
  /** Overlays (CoverChip, dots, buttons), drawn above the art and never faded. */
  children?: ReactNode;
}

/** Up to two initials from a title, skipping a leading article. */
export function coverInitials(title: string): string {
  const words = title
    .replace(/[([{].*?[)\]}]/g, ' ')
    .split(/[\s\-–—_/·:,.]+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  const meaningful = words.length > 1 && /^(the|a|an)$/i.test(words[0] ?? '') ? words.slice(1) : words;
  const letters = meaningful.slice(0, 2).map((w) => Array.from(w.replace(/[^\p{L}\p{N}]/gu, ''))[0] ?? '');
  return letters.join('').toLocaleUpperCase() || '·';
}

/** A stable small number from a string, so each placeholder sits a little differently. */
function tilt(title: string): number {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/**
 * A stable hue (0-359) from a title, so each placeholder carries its own soft
 * tint and the same album always gets the same one. FNV-1a over the code
 * points: neighbouring titles ("Vol. 1", "Vol. 2") land far apart.
 */
export function coverHue(title: string): number {
  let h = 0x811c9dc5;
  for (const ch of title.normalize('NFC')) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

/**
 * The api answers a cover whose thumbnail is still being rebuilt (after a
 * restore: backups hold no thumbnails) with a 1×1 px stand-in and an
 * X-Tagave-Placeholder header. An <img> cannot read headers, so the size
 * is the signal: real thumbnails are 300 px.
 */
export const isRebuildPlaceholder = (img: Pick<HTMLImageElement, 'naturalWidth'>) => img.naturalWidth > 0 && img.naturalWidth <= 1;

/** When to ask again for a cover that came back as the stand-in: twice, then the own placeholder stays. */
export const COVER_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000];

/** The cover URL for a retry; the query param gets past the browser's copy of the stand-in. */
export function coverRetrySrc(src: string, attempt: number): string {
  if (attempt <= 0) return src;
  return `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}`;
}

interface CoverLoadState {
  src: string | null | undefined;
  attempt: number;
  /** The last load was the rebuild stand-in: show the own placeholder until the next attempt. */
  waiting: boolean;
  failed: boolean;
}

/**
 * A square album cover. Without art it draws a quiet placeholder in the
 * design language: a field tinted with the album's own hue (coverHue), a
 * thin groove mark drawn in close around the centre and large initials in
 * the display face. Badges go in as children (CoverChip) and float in a
 * corner of the intact square; there is no strip and no seam.
 */
export function CoverArt({ src, title, alt = '', dimmed, compact = false, fill = false, loading = 'lazy', interactive = false, className, children }: CoverArtProps) {
  const t = tilt(title);
  // A cover that fails to load (gone since the list was fetched) falls back
  // to the placeholder rather than a broken image; one that is being rebuilt
  // shows the placeholder and is asked for again (COVER_RETRY_DELAYS_MS).
  const [load, setLoad] = useState<CoverLoadState>({ src, attempt: 0, waiting: false, failed: false });
  const current = load.src === src ? load : { src, attempt: 0, waiting: false, failed: false };
  if (current !== load) setLoad(current);
  useEffect(() => {
    if (!current.waiting) return;
    const delay = COVER_RETRY_DELAYS_MS[current.attempt];
    if (delay === undefined) return;
    const timer = setTimeout(() => setLoad((s) => (s.src === src ? { ...s, attempt: s.attempt + 1, waiting: false } : s)), delay);
    return () => clearTimeout(timer);
  }, [current.waiting, current.attempt, src]);
  const showImage = Boolean(src) && !current.failed && !current.waiting;
  const classes = [styles.cover, fill ? styles.fill : undefined, compact ? styles.compact : undefined, interactive ? styles.interactive : undefined, dimmed ? styles[dimmed] : undefined, className].filter(Boolean).join(' ');
  return (
    <div className={classes} style={{ '--cover-tilt': `${t}deg`, '--cover-x': `${20 + (t % 60)}%`, '--cover-hue': coverHue(title) } as React.CSSProperties}>
      {showImage ? (
        <img
          className={styles.art}
          src={coverRetrySrc(src!, current.attempt)}
          alt={alt}
          loading={loading}
          onError={() => setLoad((s) => (s.src === src ? { ...s, failed: true } : s))}
          onLoad={(e) => {
            if (isRebuildPlaceholder(e.currentTarget)) setLoad((s) => (s.src === src ? { ...s, waiting: true } : s));
          }}
        />
      ) : (
        <div className={`${styles.art} ${styles.placeholder}`} aria-hidden="true">
          <svg className={styles.groove} viewBox="0 0 100 100" focusable="false">
            <circle cx="50" cy="50" r="40" />
            <circle cx="50" cy="50" r="32" />
            <circle cx="50" cy="50" r="24" />
          </svg>
          {!compact && <span className={styles.initials}>{coverInitials(title)}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

/** A small frosted chip laid over a corner of a cover. The state is in words; colour is only a dot. */
export function CoverChip({ tone = 'neutral', corner = 'bottom-left', children }: { tone?: CoverChipTone; corner?: 'bottom-left' | 'top-left'; children: ReactNode }) {
  return (
    <span className={[styles.chip, styles[corner], styles[`tone-${tone}`]].join(' ')}>
      {children}
    </span>
  );
}
