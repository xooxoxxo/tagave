/**
 * Past runs and batches (behind the Autotagger tab's link). Runs: date,
 * population, albums, state, spent; choosing one makes it the run of the
 * steps. Batches (core: rule batches too): label, counts and Undo (a
 * model's batch needs the owner); a batch opens to Undone, Left as is and
 * Skipped with each album's reason, and what an undo cannot take back.
 */
import type { BatchDetail, BatchItemView, BatchSummary, RunView } from '@tagave/shared';
import { SKIP_LABELS } from '@tagave/shared';
import { Badge, Button, statusTone } from '../../components/ui';
import { Values } from './autotaggerParts';
import { nights } from './AcceptBandDialog';
import { BAND_LABEL, BATCH_STATE_LABEL, POPULATION_LABEL, count, money, runStateLabel, shortDate } from './autotaggerSteps';
import styles from './autotagger.module.css';

/* ---------- runs ---------- */

export function RunListView({ runs, currentId, onPick }: { runs: RunView[]; currentId: string | null; onPick: (runId: string) => void }) {
  if (runs.length === 0) return <Values rows={[['Runs', 'None']]} />;
  return (
    <div className={styles.figuresWrap}>
      <table className={styles.figures} aria-label="Runs">
        <thead><tr><th scope="col">Date</th><th scope="col">Population</th><th scope="col">Albums</th><th scope="col">State</th><th scope="col">Spent</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className={styles.runRow} data-current={r.id === currentId || undefined} onClick={() => onPick(r.id)}>
              <td><button type="button" className={styles.runPick} aria-current={r.id === currentId ? 'true' : undefined} onClick={(e) => { e.stopPropagation(); onPick(r.id); }}>{shortDate(r.createdAt)}</button></td>
              <td>{POPULATION_LABEL[r.population]}</td>
              <td>{count(r.albums)}</td>
              <td>{runStateLabel(r.state)}</td>
              <td>{r.deciderId === 'local' ? '—' : money(r.spent, r.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- batches ---------- */

export const batchName = (b: Pick<BatchSummary, 'deciderLabel' | 'band'>) =>
  [b.deciderLabel, b.band && b.band in BAND_LABEL ? BAND_LABEL[b.band as keyof typeof BAND_LABEL] : b.band].filter(Boolean).join(' · ');

/** Can this batch be undone, by this person: after its accept began, a model's only by the owner. */
export const canUndo = (b: Pick<BatchSummary, 'state' | 'decidedKind'>, owner: boolean) =>
  (b.state === 'accepting' || b.state === 'accepted' || b.state === 'failed') && (b.decidedKind === 'rule' || owner);

function countsLine(b: BatchSummary): string {
  const c = b.counts;
  return [
    ['Accepted', c.accepted], ['Undone', c.undone], ['Left as is', c.left], ['Skipped', c.skipped], [b.pendingLabel, c.pending],
  ].filter(([, n]) => (n as number) > 0).map(([l, n]) => `${l} ${count(n as number)}`).join(' · ') || 'Empty';
}

function Items({ title, items }: { title: string; items: BatchItemView[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className={styles.tracklistHead}>{`${title} · ${count(items.length)}`}</h4>
      <ul className={styles.items} aria-label={title}>
        {items.map((i) => (
          <li key={i.albumId}>
            <span>{[i.title ?? '—', i.artist].filter(Boolean).join(' · ')}</span>
            <span>{SKIP_LABELS[i.reason] ?? i.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface BatchListViewProps {
  items: BatchSummary[];
  /** the open batch's detail */
  detail?: BatchDetail | null;
  onOpen?: (batchId: string | null) => void;
  onUndo: (batchId: string) => void;
  /** the owner: model batches too */
  owner?: boolean;
  undoing?: string | null;
}

export function BatchListView({ items, detail = null, onOpen, onUndo, owner = true, undoing = null }: BatchListViewProps) {
  if (items.length === 0) return <Values rows={[['Batches', 'None']]} />;
  return (
    <ul className={styles.batches} aria-label="Batches">
      {items.map((b) => {
        const open = detail?.id === b.id ? detail : null;
        return (
          <li key={b.id} className={styles.batch}>
            <div className={styles.batchHead}>
              <span className={styles.batchName}>
                {batchName(b)}
                <span className={styles.batchDate}>{shortDate(b.createdAt)}{b.startedBy ? ` · ${b.startedBy}` : ''}</span>
              </span>
              <div className={styles.actions}>
                <Badge tone={statusTone(b.state)} size="sm">{BATCH_STATE_LABEL[b.state] ?? b.state}</Badge>
                {onOpen && <Button size="sm" variant="quiet" aria-expanded={!!open} onClick={() => onOpen(open ? null : b.id)}>{open ? 'Close' : 'Detail'}</Button>}
                {canUndo(b, owner) && <Button size="sm" variant="secondary" loading={undoing === b.id} onClick={() => onUndo(b.id)}>Undo</Button>}
              </div>
            </div>
            <p className={styles.batchCounts}>{countsLine(b)}</p>
            {b.drain && b.drain.pending > 0 && <p className={styles.batchCounts}>{`Enrichment · ${nights(b.drain.nights)}`}</p>}
            {b.failedDuring && <p className={styles.error}>{`Failed during ${b.failedDuring}${b.message ? ` · ${b.message}` : ''}`}</p>}
            {open && (
              <div className={styles.batchDetail}>
                <Values rows={[['Undone', count(open.counts.undone)], ['Left as is', count(open.counts.left)], ['Skipped', count(open.counts.skipped)]]} />
                <Items title="Left as is" items={open.left} />
                <Items title="Skipped" items={open.skipped} />
                <div>
                  <h4 className={styles.tracklistHead}>Cannot be undone</h4>
                  <ul className={styles.list}>{open.cannotUndo.map((l) => <li key={l}>{l}</li>)}</ul>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
