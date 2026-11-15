/**
 * Who decided an album's match, in one line (@tagave/shared provenanceLine):
 * 'Automatic: Jev 2026-09, probability 0.994, batch of 27 Oct, run by Ada',
 * 'By Ada', 'Automatic: matcher'. Nothing for a server too old to say.
 */
import { provenanceLine, type DecidedKind, type MatchProvenance } from '@tagave/shared';

export interface ProvenanceMatch {
  decidedBy: string;
  decidedKind?: DecidedKind | undefined;
  deciderId?: string | null | undefined;
  deciderVersion?: string | null | undefined;
  probability?: number | null | undefined;
  batch?: MatchProvenance['batch'] | undefined;
  person?: string | null | undefined;
  reason?: string | null | undefined;
}

/** The match's provenance, or null when the server sent none. */
export function provenanceOf(match: ProvenanceMatch | null | undefined): MatchProvenance | null {
  if (!match?.decidedKind) return null;
  return {
    decidedKind: match.decidedKind,
    decidedBy: match.decidedBy === 'user' ? 'user' : 'system',
    deciderId: match.deciderId ?? null,
    deciderVersion: match.deciderVersion ?? null,
    probability: match.probability ?? null,
    batch: match.batch ?? null,
    person: match.person ?? null,
    reason: match.reason ?? null,
  };
}

export function ProvenanceLine({ match, locale }: { match: ProvenanceMatch | null | undefined; locale?: string }) {
  const p = provenanceOf(match);
  if (!p) return null;
  return <span>{provenanceLine(p, locale ? { locale } : {})}</span>;
}
