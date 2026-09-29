import { useId } from 'react';

/**
 * The tagave mark: an agave rosette resting in a dew-glass orb. The same
 * drawing is the favicon (public/tagave-mark.svg), the landing page mark and
 * the og image. Colours come from the dew tokens, so it follows the theme the
 * way the primary button does: a deep drop with a white plant in light mode,
 * a lit drop with a dark plant in dark mode. It is decorative next to the
 * live "tagave" wordmark, so it is hidden from assistive technology.
 */
export function BrandMark({ className, size = 32 }: { className?: string | undefined; size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}b`} x1="18" y1="4" x2="46" y2="62" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--dew-hi)" />
          <stop offset=".55" stopColor="var(--dew)" />
          <stop offset="1" stopColor="var(--dew-lo)" />
        </linearGradient>
        <radialGradient id={`${id}s`} cx="23" cy="17" r="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity=".55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill={`url(#${id}b)`} />
      <circle cx="32" cy="32" r="30" fill={`url(#${id}s)`} />
      <g fill="var(--dew-ink)">
        {AGAVE.map((d) => <path key={d} d={d} />)}
      </g>
      <circle cx="32" cy="32" r="29.4" fill="none" stroke="var(--rim-a)" strokeOpacity=".6" strokeWidth="1.2" />
    </svg>
  );
}

/** The rosette: a tall centre leaf, two rising leaves, two low ones, a base.
 *  Separate paths, so overlapping leaves never cancel out under the fill rule. */
export const AGAVE = [
  'M26.5 50C27 38 29 25 32 13C35 25 37 38 37.5 50Z',
  'M25 50C23.5 40 21 31 16.5 22.5C24.5 28.5 30 37.5 32.5 50Z',
  'M39 50C40.5 40 43 31 47.5 22.5C39.5 28.5 34 37.5 31.5 50Z',
  'M24 50.5C19.5 45 14.5 41.5 8.8 39.2C17 38 24.5 41.5 30 50.5Z',
  'M40 50.5C44.5 45 49.5 41.5 55.2 39.2C47 38 39.5 41.5 34 50.5Z',
  'M22 49.2Q32 47.6 42 49.2Q41 52 32 52Q23 52 22 49.2Z',
];
