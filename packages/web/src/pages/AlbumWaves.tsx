import { useEffect, useRef } from 'react';
import { coverSource } from '../adaptive/AdaptiveColour';
import { playerAnalyser } from '../adaptive/levels';
import { FILLER_MIN_HEIGHT } from './albumFlow';
import styles from './AlbumDetailPage.module.css';

const LINES = [0, 1, 2, 3];

export function AlbumWaves({ coverUrl, playing }: { coverUrl: string | null | undefined; playing: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  const playingNow = useRef(playing);
  playingNow.current = playing;

  useEffect(() => {
    const svg = ref.current;
    if (!svg || !coverUrl) return;
    let current = true;
    void coverSource(coverUrl).then((argb) => {
      if (current && argb !== null) svg.style.color = `#${(argb & 0xffffff).toString(16).padStart(6, '0')}`;
    });
    return () => { current = false; svg.style.removeProperty('color'); };
  }, [coverUrl]);

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const paths = [...svg.querySelectorAll('path')];
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    let analyser: AnalyserNode | null = null;
    let attempted = false;
    let visible = true;
    let thin = false;
    let disposed = false;
    let frame = 0;
    let last = 0;
    let energy = 0;
    const samples = new Uint8Array(512);

    function draw(time: number) {
      if (playingNow.current && !reduced?.matches && !attempted) {
        attempted = true;
        void playerAnalyser().then((node) => { if (!disposed) analyser = node; });
      }
      if (!playingNow.current) attempted = false;
      let level = 0;
      if (playingNow.current && analyser && !reduced?.matches) {
        analyser.getByteTimeDomainData(samples);
        for (const sample of samples) level += ((sample - 128) / 128) ** 2;
        level = Math.min(1, 4 * Math.sqrt(level / samples.length));
      }
      energy += (level - energy) * (level > energy ? 0.35 : 0.1);
      paths.forEach((path, line) => {
        let d = '';
        for (let x = 0; x <= 800; x += 16) {
          const envelope = Math.sin(Math.PI * x / 800);
          const wave = Math.sin(x / (68 + line * 12) + time + line * 0.8) + 0.35 * Math.sin(x / 49 - time * 1.3);
          const y = 47 + line * 15 + envelope * wave * (7 + line * 3 + energy * 25);
          d += `${x ? 'L' : 'M'}${x},${y.toFixed(1)}`;
        }
        path.setAttribute('d', d);
      });
    }

    function tick(now: number) {
      if (now - last >= 33) { draw(now / 2600); last = now; }
      frame = requestAnimationFrame(tick);
    }

    function sync() {
      cancelAnimationFrame(frame);
      if (!visible || thin || document.visibilityState === 'hidden') return;
      if (reduced?.matches) draw(0.5);
      else frame = requestAnimationFrame(tick);
    }

    const resize = () => {
      thin = svg.clientHeight < FILLER_MIN_HEIGHT;
      svg.toggleAttribute('data-thin', thin);
      sync();
    };
    const size = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    size?.observe(svg);
    const view = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      sync();
    });
    view?.observe(svg);
    reduced?.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    resize();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      size?.disconnect();
      view?.disconnect();
      reduced?.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  return <svg ref={ref} className={`${styles.filler} ${styles.albumWaves}`} viewBox="0 0 800 144" preserveAspectRatio="none" aria-hidden="true">
    {LINES.map((line) => <path key={line} fill="none" stroke="currentColor" strokeOpacity={0.22 + line * 0.15} vectorEffect="non-scaling-stroke" />)}
  </svg>;
}
