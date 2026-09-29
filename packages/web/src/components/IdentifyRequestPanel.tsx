/**
 * The owner's identification request for one album, as it really stands:
 * queued → running → matched / could not be matched / a release group to
 * pick from / the id does not exist / failed. Read from the album detail's
 * identifyRequest (live pg-boss job + the outcome the worker recorded); the
 * page polls while the job is live, so "queued" never outlives the job.
 */
import type { IdentifyOutcomeKind, IdentifyRequestView, ReleaseChoice } from '@liner/shared';
import { Badge, Button, type BadgeTone } from './ui';
import { formatRelativeTime } from '../utils/time';
import styles from './IdentifyRequestPanel.module.css';

export const REQUEST_KIND_LABEL: Record<IdentifyRequestView['kind'], string> = {
  mbid: 'Manual match (MusicBrainz)',
  release_group: 'Manual match (MusicBrainz release group)',
  discogs: 'Manual match (Discogs)',
  reidentify: 'Re-identify',
  sweep: 'Identification sweep',
};

const OUTCOME_TITLE: Record<IdentifyOutcomeKind, string> = {
  matched: 'Matched',
  needs_review: 'Needs your review',
  unidentified: 'Could not be matched',
  release_group: 'Pick a release',
  not_found: 'ID not found',
  failed: 'Lookup failed',
  cancelled: 'Cancelled',
  skipped: 'Nothing to do',
  unknown: 'Finished',
};

type Tone = 'live' | 'good' | 'attention' | 'bad' | 'quiet';
const OUTCOME_TONE: Record<IdentifyOutcomeKind, Tone> = {
  matched: 'good',
  needs_review: 'attention',
  unidentified: 'attention',
  release_group: 'attention',
  not_found: 'bad',
  failed: 'bad',
  cancelled: 'quiet',
  skipped: 'quiet',
  unknown: 'quiet',
};

/** The outcomes that ask the owner to do something next. */
export const ACTIONABLE: ReadonlySet<IdentifyOutcomeKind> = new Set(['release_group', 'not_found', 'failed', 'needs_review', 'unidentified']);

/** One line: where the live request is. */
export function liveRequestLine(r: IdentifyRequestView): string {
  if (r.status === 'running') return 'running now';
  if (r.status === 'retrying') return 'the providers were busy; it runs again shortly';
  return r.jobsAhead === 0 ? 'next in line' : `${r.jobsAhead.toLocaleString()} ahead in the queue`;
}

/** Whole-sentence summary for the Activity face. */
export function requestSummary(r: IdentifyRequestView): string {
  const kind = REQUEST_KIND_LABEL[r.kind] ?? 'Identification';
  if (r.status !== 'done') return `${kind} ${r.status === 'queued' ? 'queued' : r.status} · ${liveRequestLine(r)}${r.createdAt ? ` · since ${new Date(r.createdAt).toLocaleString()}` : ''}`;
  const o = r.outcome;
  if (!o) return `${kind} finished.`;
  return `${kind}${r.pinned ? ` (${r.pinned})` : ''}: ${OUTCOME_TITLE[o.kind]} — ${o.message} (${new Date(o.finishedAt).toLocaleString()})`;
}

function fitBadge(c: ReleaseChoice): { tone: BadgeTone; label: string } {
  if (c.trackDelta == null) return { tone: 'neutral', label: 'Track count unknown' };
  if (c.fit === 'exact') return { tone: 'success', label: `${c.trackCount} tracks, like yours` };
  const d = c.trackDelta;
  const diff = d === 0 ? 'other disc count' : `${d > 0 ? `${d} more` : `${-d} fewer`} track${Math.abs(d) === 1 ? '' : 's'}`;
  return { tone: c.fit === 'close' ? 'warning' : 'neutral', label: `${c.trackCount} tracks · ${diff}` };
}

function choiceFacts(c: ReleaseChoice): string {
  return [
    c.date,
    c.country,
    c.formats,
    c.label ? `${c.label}${c.catalogNumber ? ` ${c.catalogNumber}` : ''}` : null,
    c.status && c.status !== 'Official' ? c.status : null,
  ].filter(Boolean).join(' · ');
}

export interface IdentifyRequestPanelProps {
  request: IdentifyRequestView;
  onCancel: () => void;
  cancelling: boolean;
  cancelError?: string | null;
  /** queue a manual match to this release (a release-group pick) */
  onPick: (releaseMbid: string) => void;
  /** the release being queued, while its request is sent */
  picking: string | null;
  pickError?: string | null;
  onDismiss?: () => void;
}

export function IdentifyRequestPanel({
  request: r, onCancel, cancelling, cancelError, onPick, picking, pickError, onDismiss,
}: IdentifyRequestPanelProps) {
  const kind = REQUEST_KIND_LABEL[r.kind] ?? 'Identification';
  const live = r.status !== 'done';
  const o = r.outcome;
  const tone: Tone = live ? 'live' : o ? OUTCOME_TONE[o.kind] : 'quiet';
  const title = live
    ? `${kind} ${r.status === 'queued' ? 'queued' : r.status === 'running' ? 'running' : 'retrying'}`
    : o ? OUTCOME_TITLE[o.kind] : 'Finished';
  const meta = live
    ? [r.pinned, liveRequestLine(r), r.createdAt ? `since ${new Date(r.createdAt).toLocaleString()}` : null]
    : [kind, r.pinned, o ? formatRelativeTime(o.finishedAt) : null];

  return (
    <div className={`${styles.panel} ${styles[`tone-${tone}`]}`} role="status" aria-live="polite">
      <div className={styles.head}>
        <span className={styles.title}>{title}</span>
        <span className={styles.meta}>{meta.filter(Boolean).join(' · ')}</span>
        {r.status === 'queued' && (
          <Button variant="secondary" size="sm" onClick={onCancel} loading={cancelling} title="Remove this request from the queue">
            Cancel
          </Button>
        )}
        {!live && onDismiss && (
          <Button variant="quiet" size="sm" onClick={onDismiss} title="Hide this note">
            Dismiss
          </Button>
        )}
      </div>
      {cancelError && <p className={styles.error}>{cancelError}</p>}
      {o && <p className={styles.message}>{o.message}</p>}
      {o?.choices && o.choices.length > 0 && (
        <ul className={styles.choices} aria-label="Releases in this release group">
          {o.choices.map((c) => {
            const fit = fitBadge(c);
            return (
              <li key={c.mbid} className={styles.choice}>
                <div className={styles.choiceMain}>
                  <span className={styles.choiceTitle}>
                    {c.title}{c.disambiguation ? <span className={styles.choiceDis}> ({c.disambiguation})</span> : null}
                  </span>
                  <span className={styles.choiceFacts}>{choiceFacts(c) || 'No release details on MusicBrainz'}</span>
                </div>
                <Badge tone={fit.tone} className={styles.choiceFit ?? ''}>{fit.label}</Badge>
                <span className={styles.choiceActions}>
                  <a className={styles.choiceLink} href={`https://musicbrainz.org/release/${c.mbid}`} target="_blank" rel="noreferrer">
                    MusicBrainz ↗
                  </a>
                  <Button variant={c.fit === 'exact' ? 'primary' : 'secondary'} size="sm" onClick={() => onPick(c.mbid)} loading={picking === c.mbid} disabled={!!picking && picking !== c.mbid}>
                    Match this release
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {o?.releaseGroup && (o.moreChoices ?? 0) > 0 && (
        <p className={styles.more}>
          {o.moreChoices!.toLocaleString()} more {o.moreChoices === 1 ? 'release' : 'releases'} —{' '}
          <a href={`https://musicbrainz.org/release-group/${o.releaseGroup.mbid}`} target="_blank" rel="noreferrer">see them all on MusicBrainz</a>
          {' '}and paste the one you have.
        </p>
      )}
      {pickError && <p className={styles.error}>{pickError}</p>}
    </div>
  );
}
