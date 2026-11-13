/**
 * Who decided an album's match, as the album page shows it in one line:
 *   model   'Automatic: Jev 2026-09, probability 0.994, batch of 27 Oct, run by Ada'
 *   rule    'Automatic: your rules[, batch of …][, run by …]'
 *   system  'Automatic: matcher'
 *   user    'By Ada', or 'By a person' when the person is gone
 *   unknown 'Decided before provenance was kept'
 */
import type { DecidedKind } from './album.js';
import { deciderLabel } from './batches.js';

export interface MatchProvenance {
  decidedKind: DecidedKind;
  decidedBy: 'system' | 'user';
  deciderId: string | null;
  deciderVersion: string | null;
  /** the decider's probability for the chosen tracklist (a model's decision only) */
  probability: number | null;
  /** the accept batch the match came in, with who started it */
  batch: { id: string; createdAt: string; startedBy: string | null } | null;
  /** the person who decided (decided_by_user_id), by name */
  person: string | null;
  reason: string | null;
}

export function provenanceLine(p: MatchProvenance, opts: { locale?: string } = {}): string {
  const batch = (): string => {
    if (!p.batch) return '';
    const day = new Intl.DateTimeFormat(opts.locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(p.batch.createdAt));
    return `, batch of ${day}${p.batch.startedBy ? `, run by ${p.batch.startedBy}` : ''}`;
  };
  switch (p.decidedKind) {
    case 'model': {
      const label = deciderLabel(p.deciderId ?? 'model', p.deciderVersion);
      const prob = p.probability === null ? '' : `, probability ${p.probability.toFixed(3)}`;
      return `Automatic: ${label}${prob}${batch()}`;
    }
    case 'rule': return `Automatic: your rules${batch()}`;
    case 'system': return 'Automatic: matcher';
    case 'user': return p.person ? `By ${p.person}` : 'By a person';
    default: return 'Decided before provenance was kept';
  }
}
