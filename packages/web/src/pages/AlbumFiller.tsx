/**
 * Short albums (≤ 3 tracks): a generative piece under the tracklist, ripple
 * contours in the accent colour seeded by the album title (same title, same
 * piece), fading in from the tracklist. Decoration only: no text, hidden
 * from assistive technology. Redrawn when its size or the theme changes.
 */
import { useEffect, useRef } from 'react';
import { drawFiller } from './albumFlow';
import styles from './AlbumDetailPage.module.css';

export function AlbumFiller({ title, height }: { title: string; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let width = 0;
    const paint = () => {
      const ink = getComputedStyle(cv).getPropertyValue('--dew').trim() || '#276a82';
      drawFiller(cv, title, ink);
    };
    paint();
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => { if (cv.clientWidth !== width) { width = cv.clientWidth; paint(); } })
      : null;
    ro?.observe(cv);
    const scheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    scheme?.addEventListener('change', paint);
    const themeWatch = typeof MutationObserver !== 'undefined' ? new MutationObserver(paint) : null;
    themeWatch?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      ro?.disconnect();
      scheme?.removeEventListener('change', paint);
      themeWatch?.disconnect();
    };
  }, [title, height]);
  return <canvas ref={ref} className={styles.filler} style={{ height }} aria-hidden="true" data-album-filler="" />;
}
