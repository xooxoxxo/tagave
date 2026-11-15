/**
 * Accept band (step 4): what the batch would hold, from GET
 * …/runs/:runId/accept-preview, before Confirm starts it. Albums, already
 * accepted, excluded as wrong, not pinned, linked apps; what an undo cannot
 * take back; and the enrichment the nightly bridge needs, with Drain faster.
 */
import type { AcceptPreview } from '@tagave/shared';
import { Button } from '../../components/ui';
import { ReviewDialog } from './ReviewDialog';
import { Values } from './autotaggerParts';
import { BAND_LABEL, count, percent } from './autotaggerSteps';
import styles from './autotagger.module.css';

export interface AcceptBandDialogViewProps {
  preview: AcceptPreview;
  onConfirm: () => void;
  onCancel: () => void;
  /** the next pace of the nightly bridge (null at the fastest, or not the owner's) */
  onDrainFaster?: (() => void) | null;
  confirming?: boolean;
  draining?: boolean;
  error?: string | null;
}

export const nights = (n: number) => `about ${count(n)} ${n === 1 ? 'night' : 'nights'}`;

export function AcceptBandDialogView({ preview, onConfirm, onCancel, onDrainFaster = null, confirming = false, draining = false, error = null }: AcceptBandDialogViewProps) {
  const p = preview;
  return (
    <ReviewDialog
      title={`Accept band · ${BAND_LABEL[p.band]}`}
      onClose={onCancel}
      footer={(
        <>
          <Button variant="quiet" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" data-autofocus loading={confirming} disabled={!p.gate.allowed || p.albums === 0} onClick={onConfirm}>
            {`Accept ${count(p.albums)} albums`}
          </Button>
        </>
      )}
    >
      <div className={styles.dialogBody}>
        <Values
          label="Batch"
          rows={[
            ['Albums', count(p.albums)],
            ['Already accepted', count(p.alreadyAccepted)],
            ['Excluded wrong', count(p.excludedWrong)],
            ['Not pinned', count(p.notPinned)],
            ['Linked apps', count(p.linkedApps)],
            ['Upper bound', percent(p.gate.upper, 2)],
          ]}
        />
        <div>
          <h3 className={styles.tracklistHead}>Cannot be undone</h3>
          <ul className={styles.list}>
            {p.cannotUndo.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </div>
        <div className={styles.actions}>
          <Values rows={[['Enrichment', nights(p.drain.nights)], ['Per night', count(p.drain.perNight)]]} />
          {onDrainFaster && <Button size="sm" variant="secondary" loading={draining} onClick={onDrainFaster}>Drain faster</Button>}
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
    </ReviewDialog>
  );
}
