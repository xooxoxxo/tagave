/**
 * The interface every decider implements (Jev now, an owner's or another
 * provider's model later). A decider answers one probability per tracklist
 * group; the decision and the edition are made from that answer by
 * decideFromProbabilities and pickEdition, never by the decider.
 *
 * The album evidence carries local values with their source. A decider that
 * sends anything out sends a title or a year only when its source is `tag`;
 * every other value goes as the spec's placeholder.
 */
import type { AlbumEvidence, CandidateEvidence, EvidenceCandidate } from '../matching/evidence.js';
import type { TracklistGroup } from './grouping.js';

/** How one album's request is made (requestOptions gives the run's and the preview's). */
export interface RequestOptions {
  model: string;
  /** an album of the weak population: only its best few candidates go */
  weak?: boolean;
  /** a sendable candidate of the album has no evidence yet (the loader leaves such candidates out) */
  partial?: boolean;
  /** the library's limit on a request's size; null or missing: none */
  maxRequestBytes?: number | null;
}

/**
 * One album's request as a decider makes it: the payload it sends, in its
 * own format, and the groups it was made from.
 */
export interface DeciderRequest<C extends EvidenceCandidate = EvidenceCandidate> {
  /** what is sent, as it is sent */
  payload: unknown;
  /** UTF-8 bytes of the payload as sent */
  bytes: number;
  /** every tracklist group of the candidates (the decision's group and its editions come from here) */
  groups: TracklistGroup[];
  /** the groups shown, with the editions shown */
  sent: TracklistGroup[];
  /** the labels of the groups shown, the only answers the decision reads */
  labels: string[];
  /** the candidates grouped: each release once, in distance order */
  candidates: Array<C & { evidence: CandidateEvidence }>;
}

/**
 * One album to decide: its evidence, the groups shown and the payload the
 * decider's own build made from them. ask sends the payload as it is.
 */
export interface DeciderInput { album: AlbumEvidence; groups: TracklistGroup[]; payload: unknown }
export interface DeciderAnswer {
  /** group label → probability; validated by decideFromProbabilities, not trusted */
  probabilities: Record<string, number>;
  /** the dated model name the provider answered with */
  model: string;
  inputTokens: number;
  requestBytes: number;
  raw: unknown;
}
export interface Decider {
  id: string;
  specHash: string;
  /**
   * The request for one album, from its sendable candidates. Throws
   * NotSendableError when the album may not be sent as it is.
   */
  build<C extends EvidenceCandidate>(album: AlbumEvidence, candidates: C[], opts: RequestOptions): DeciderRequest<C>;
  ask(input: DeciderInput, opts: { model: string }): Promise<DeciderAnswer>;
}
