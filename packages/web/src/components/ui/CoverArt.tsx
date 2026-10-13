import type { ReactNode } from 'react';
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
 * A square album cover. Without art it draws a quiet placeholder in the
 * design language: a field tinted with the album's own hue (coverHue), a
 * thin groove mark drawn in close around the centre and large initials in
 * the display face. Badges go in as children (CoverChip) and float in a
 * corner of the intact square; there is no strip and no seam.
 */
export function CoverArt({ src, title, alt = '', dimmed, compact = false, fill = false, loading = 'lazy', interactive = false, className, children }: CoverArtProps) {
  const t = tilt(title);
  const classes = [styles.cover, fill ? styles.fill : undefined, compact ? styles.compact : undefined, interactive ? styles.interactive : undefined, dimmed ? styles[dimmed] : undefined, className].filter(Boolean).join(' ');
  return (
    <div className={classes} style={{ '--cover-tilt': `${t}deg`, '--cover-x': `${20 + (t % 60)}%`, '--cover-hue': coverHue(title) } as React.CSSProperties}>
      {src ? (
        <img className={styles.art} src={src} alt={alt} loading={loading} />
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
