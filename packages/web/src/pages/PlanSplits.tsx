/**
 * A tag plan's splits (0089) on the plan page: each album the plan splits
 * first, in one line by where it stands, and the per-track files it makes
 * (their names, lengths and how sure each cut is) once the cut points are
 * found. Low cuts are checked in the split sheet before Apply.
 */
import { clockOf, sampleMs, splitDoneLine, type PlanSplit } from '@tagave/shared';
import { Badge, Button } from '../components/ui';
import styles from './PlanSplits.module.css';

const CONFIDENCE = { high: 'High', medium: 'Medium', low: 'Low' } as const;

/** One line per split, by state. */
export function splitStateLine(s: Pick<PlanSplit, 'state' | 'tracks' | 'low' | 'error'>): string {
  switch (s.state) {
    case 'analyzing': return `Finding cut points · ${s.tracks} tracks`;
    case 'ready': return s.low > 0 ? `Splits into ${s.tracks} tracks first · ${s.low} Low ${s.low === 1 ? 'cut' : 'cuts'}` : `Splits into ${s.tracks} tracks first`;
    case 'splitting': return `Splitting into ${s.tracks} tracks…`;
    case 'done': return splitDoneLine(s.tracks);
    case 'failed': return `Split stopped: ${s.error ?? 'nothing changed'}`;
    case 'undone': return 'Split undone';
  }
}

export function PlanSplits({ splits, onCheck }: { splits: PlanSplit[]; onCheck: ((s: PlanSplit) => void) | null }) {
  if (splits.length === 0) return null;
  return (
    <section className={styles.splits} aria-label="Split first">
      {splits.map((s) => (
        <div key={s.splitId} className={styles.split} data-state={s.state}>
          <div className={styles.head}>
            <p className={s.state === 'failed' || (s.state === 'ready' && s.low > 0) ? styles.lineWarn : styles.line} role="status">{splitStateLine(s)}</p>
            {onCheck && s.state === 'ready' && s.plan && <Button variant="secondary" size="sm" onClick={() => onCheck(s)}>Check cuts</Button>}
          </div>
          {s.plan && (s.state === 'ready' || s.state === 'splitting' || s.state === 'done') && (
            <ol className={styles.files} aria-label="New files">
              {s.plan.tracks.map((t) => (
                <li key={t.n} className={styles.file}>
                  <span className={styles.name}>{t.fileName}</span>
                  <span className={styles.len}>{clockOf(sampleMs(t.endSample - t.startSample, s.plan!.sampleRate))}</span>
                  <span className={styles.conf}>
                    {t.confidence && t.confidence !== 'high' && <Badge tone={t.confidence === 'low' ? 'warning' : 'neutral'}>{CONFIDENCE[t.confidence]}</Badge>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </section>
  );
}
