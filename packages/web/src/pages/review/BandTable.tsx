/**
 * The spot-check gate per band, from GET …/runs/:runId/bands: the Gates
 * panel beside the spot-check card (a meter of the error bound against the
 * max-error line, and Open / Needs <n> more / —), and the Accept step's one
 * row per band (picks, checked, errors, upper bound, gate) with Check 25
 * while the gate is closed and Accept band, for the owner, once it is open.
 */
import type { BandId, BandRow } from '@tagave/shared';
import { Badge, Button } from '../../components/ui';
import { BAND_LABEL, count, gateLabel, meter, openAlbums, percent } from './autotaggerSteps';
import styles from './autotagger.module.css';

function GateMeter({ row, maxErrorRate }: { row: BandRow; maxErrorRate: number }) {
  const m = meter(row.checked > 0 ? row.upper : 0, maxErrorRate);
  return (
    <span className={styles.meter} data-open={row.allowed || undefined} role="img" aria-label={`Upper bound ${percent(row.upper, 2)}, limit ${percent(maxErrorRate)}`}>
      {row.checked > 0 && <span className={styles.meterFill} style={{ width: `${m.fill * 100}%` }} />}
      <span className={styles.meterLine} style={{ left: `${m.line * 100}%` }} />
    </span>
  );
}

export interface GatesPanelViewProps {
  rows: BandRow[];
  maxErrorRate: number;
  /** the owner: Go to Accept */
  canAccept: boolean;
  onGoToAccept: () => void;
}

export function GatesPanelView({ rows, maxErrorRate, canAccept, onGoToAccept }: GatesPanelViewProps) {
  const albums = rows.reduce((n, r) => n + openAlbums(r), 0);
  return (
    <>
      <div className={styles.gates}>
        <h4 className={styles.gatesTitle}>{`Gates · limit ${percent(maxErrorRate)}`}</h4>
        {rows.map((r) => {
          const g = gateLabel(r);
          return (
            <div key={r.band} className={styles.gateRow}>
              <span className={styles.gateBand}>{BAND_LABEL[r.band]}</span>
              <GateMeter row={r} maxErrorRate={maxErrorRate} />
              <Badge tone={g.tone} size="sm">{g.label}</Badge>
            </div>
          );
        })}
      </div>
      {canAccept && albums > 0 && <Button variant="primary" onClick={onGoToAccept}>{`Go to Accept · ${count(albums)} albums`}</Button>}
    </>
  );
}

export interface BandTableViewProps {
  rows: BandRow[];
  /** the owner: Accept band on an open gate */
  canAccept: boolean;
  onDraw: (band: BandId) => void;
  onAccept: (band: BandId) => void;
  /** the band whose checks are being drawn */
  drawing?: BandId | null;
}

export function BandTableView({ rows, canAccept, onDraw, onAccept, drawing = null }: BandTableViewProps) {
  return (
    <ul className={styles.bands} aria-label="Bands">
      <li className={`${styles.band} ${styles.bandHead}`} aria-hidden="true">
        <span>Band</span><span>Picks</span><span>Checked</span><span>Errors</span><span>Upper bound</span><span>Gate</span><span />
      </li>
      {rows.map((r) => {
        const g = gateLabel(r);
        const left = openAlbums(r);
        return (
          <li key={r.band} className={styles.band}>
            <span className={styles.bandName}>{BAND_LABEL[r.band]}</span>
            <span><span className={styles.cellLabel}>Picks</span>{count(r.picks)}</span>
            <span><span className={styles.cellLabel}>Checked</span>{count(r.checked)}</span>
            <span><span className={styles.cellLabel}>Errors</span>{count(r.errors)}</span>
            <span><span className={styles.cellLabel}>Upper bound</span>{r.checked > 0 ? percent(r.upper, 2) : 'Not checked'}</span>
            <span><Badge tone={g.tone} size="sm">{g.label}</Badge></span>
            <span className={styles.bandAction}>
              {r.allowed && left > 0
                ? canAccept && <Button size="sm" variant="secondary" onClick={() => onAccept(r.band)}>Accept band</Button>
                : r.allowed && r.accepted > 0
                  ? <span className={styles.muted}>{`${count(r.accepted)} accepted`}</span>
                  : r.picks > 0 && <Button size="sm" variant="quiet" loading={drawing === r.band} onClick={() => onDraw(r.band)}>Check 25</Button>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
