/**
 * Library care › Autotagger › 3 · Spot check, the decider's agreement with
 * the owner, per band: the backtest and the review queue. Shown to anyone
 * on the tab (the API gives it to library.edit). A pure view.
 */
import type { AgreementRow, AgreementView as Agreement } from '@tagave/shared';
import { Values } from './autotaggerParts';
import { BAND_LABEL, count } from './autotaggerSteps';
import styles from './autotagger.module.css';

function AgreementTable({ label, rows }: { label: string; rows: AgreementRow[] }) {
  return (
    <div className={styles.figuresWrap}>
      <table className={styles.figures} aria-label={label}>
        <thead><tr><th scope="col">Band</th><th scope="col">Decided</th><th scope="col">Agree</th><th scope="col">Disagree</th><th scope="col">No decision</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.band}>
              <td>{r.band in BAND_LABEL ? BAND_LABEL[r.band as keyof typeof BAND_LABEL] : 'None'}</td>
              <td>{count(r.decided)}</td>
              <td>{count(r.agree)}</td>
              <td>{count(r.disagree)}</td>
              <td>{count(r.noDecision)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgreementView({ agreement }: { agreement: Agreement | null }) {
  return (
    <section className={styles.section} aria-label="Agreement">
      <h3 className={styles.sectionTitle}>Agreement</h3>
      {agreement?.backtest ? <><h4 className={styles.tracklistHead}>Backtest</h4><AgreementTable label="Backtest" rows={agreement.backtest.rows} /></> : <Values rows={[['Backtest', 'None']]} />}
      {agreement && agreement.queue.length > 0 ? <><h4 className={styles.tracklistHead}>Review queue</h4><AgreementTable label="Review queue" rows={agreement.queue} /></> : <Values rows={[['Review queue', 'None']]} />}
    </section>
  );
}
