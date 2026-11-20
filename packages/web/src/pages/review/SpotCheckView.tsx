/**
 * Library care › Autotagger, step 3: the spot check, one album at a time.
 * The band (99% · 97% · 95% · 90%) and how many of its drawn checks have a
 * verdict; the album's cover, title and files beside the edition the
 * decider picked (number, title, length), the edition line and a stale
 * marker; Correct · Wrong · Unsure, also on C, W and U. A verdict moves on
 * to the next pending check (the container drops the answered one). Check
 * 25 draws more of the band.
 */
import { useEffect, useRef } from 'react';
import type { BandId, BandRow, SpotCheckItem } from '@tagave/shared';
import { BAND_IDS } from '@tagave/shared';
import { Badge, Button, CoverArt, SegmentedControl } from '../../components/ui';
import { BAND_LABEL, count, verdictForKey } from './autotaggerSteps';
import styles from './autotagger.module.css';

export type Verdict = 'correct' | 'wrong' | 'unsure';

export const VERDICTS: ReadonlyArray<readonly [Verdict, string, string]> = [
  ['correct', 'Correct', 'C'],
  ['wrong', 'Wrong', 'W'],
  ['unsure', 'Unsure', 'U'],
];

export interface SpotCheckCardViewProps {
  band: BandId;
  bands: BandRow[];
  onBand: (band: BandId) => void;
  /** the first pending check of the band, or null when none waits */
  item: SpotCheckItem | null;
  coverUrl?: string | null;
  onVerdict: (verdict: Verdict) => void;
  onDraw: () => void;
  /** a verdict on its way: the keys wait */
  pending?: boolean;
  drawing?: boolean;
  /** listen for C, W and U on the page (off in a story grid with more than one card) */
  keys?: boolean;
  error?: string | null;
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"], dialog[open]');
};

type KeyEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'defaultPrevented' | 'target' | 'preventDefault'>;

/**
 * C, W or U on the page gives the card's check that verdict, once: not
 * while typing in a field, not while a dialog is open, not while the last
 * verdict is on its way, not on a held key. Returns whether it did.
 */
export function handleVerdictKey(
  e: KeyEvent,
  state: { item: SpotCheckItem | null; pending: boolean; onVerdict: (v: Verdict) => void },
  dialogOpen: boolean,
): boolean {
  if (e.defaultPrevented || e.repeat || dialogOpen || typing(e.target)) return false;
  const v = verdictForKey(e);
  if (!v || !state.item || state.pending) return false;
  e.preventDefault();
  state.onVerdict(v);
  return true;
}

export function SpotCheckCardView({ band, bands, onBand, item, coverUrl = null, onVerdict, onDraw, pending = false, drawing = false, keys = true, error = null }: SpotCheckCardViewProps) {
  const row = bands.find((b) => b.band === band) ?? null;
  const latest = useRef({ item, pending, onVerdict });
  latest.current = { item, pending, onVerdict };

  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => { handleVerdictKey(e, latest.current, !!document.querySelector('dialog[open]')); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [keys]);

  const albumMeta = item
    ? [item.album.artist, item.album.year, `${count(item.album.tracks.length)} files`].filter((x) => x !== null && x !== undefined).join(' · ')
    : '';
  const edition = item
    ? [
        item.chosen.label, item.chosen.year, item.chosen.format, item.chosen.country,
        item.groupSize > 1 ? `1 of ${count(item.groupSize)} editions with this tracklist` : null,
      ].filter((x) => x !== null && x !== undefined && x !== '').join(' · ')
    : '';
  const rows = item ? Math.max(item.album.tracks.length, item.chosen.tracks.length) : 0;

  return (
    <section className={styles.card} aria-label="Spot check">
      <div className={styles.cardBar}>
        <SegmentedControl
          size="sm"
          label="Band"
          value={band}
          onChange={onBand}
          options={BAND_IDS.map((b) => ({ value: b, label: BAND_LABEL[b] }))}
        />
        <div className={styles.actions}>
          {row && <span className={styles.position}>{`${count(row.drawn - row.pending)} of ${count(row.drawn)}`}</span>}
          {item && <Button size="sm" variant="quiet" loading={drawing} onClick={onDraw}>Check 25</Button>}
        </div>
      </div>

      {item ? (
        <>
          <div className={styles.album}>
            <span className={styles.cover}><CoverArt src={coverUrl} title={item.album.title ?? item.chosen.title} compact /></span>
            <div className={styles.albumText}>
              <h3 className={styles.albumTitle}>{item.album.title ?? item.chosen.title}</h3>
              <p className={styles.albumMeta}>{albumMeta}</p>
            </div>
          </div>

          <div className={styles.tracklists}>
            <div>
              <h4 className={styles.tracklistHead}>Your files</h4>
              <ol className={styles.tracklist} aria-label="Your files">
                {item.album.tracks.map((t, i) => (
                  <li key={`${t.n}-${i}`} className={styles.track}>
                    <span className={styles.trackNo}>{t.n}</span>
                    <span className={styles.trackTitle}>{t.title ?? 'Untitled'}</span>
                    <span className={styles.trackLength}>{t.length ?? '–:––'}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h4 className={styles.tracklistHead}>Picked release</h4>
              <ol className={styles.tracklist} aria-label="Picked release">
                {item.chosen.tracks.map((t, i) => (
                  <li key={`${t.n}-${i}`} className={styles.track}>
                    <span className={styles.trackNo}>{t.n}</span>
                    <span className={styles.trackTitle}>{t.title}</span>
                    <span className={styles.trackLength}>{t.length ?? '–:––'}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          {rows === 0 && <p className={styles.muted}>No tracks</p>}

          <div className={styles.actions}>
            <p className={styles.edition}>{[item.chosen.title !== item.album.title ? item.chosen.title : null, edition].filter(Boolean).join(' · ')}</p>
            {item.probability !== null && <Badge size="sm">{`Probability ${item.probability.toFixed(3)}`}</Badge>}
            {item.stale && <Badge tone="warning" size="sm">Changed since</Badge>}
          </div>

          <div className={styles.verdicts} role="group" aria-label="Verdict">
            {VERDICTS.map(([v, label, key]) => (
              <Button key={v} variant={v === 'unsure' ? 'quiet' : 'secondary'} disabled={pending} aria-keyshortcuts={key} onClick={() => onVerdict(v)}>
                {label}<kbd className={styles.kbd} aria-hidden="true">{key}</kbd>
              </Button>
            ))}
          </div>
        </>
      ) : (
        <div className={styles.empty}>
          <p className={styles.emptyValue}>{row && row.picks === 0 ? 'No picks' : '0 pending'}</p>
          {row && row.picks > 0 && row.drawn < row.picks && <Button variant="secondary" loading={drawing} onClick={onDraw}>Check 25</Button>}
        </div>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}
