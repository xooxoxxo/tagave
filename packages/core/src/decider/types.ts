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
import type { AlbumEvidence } from '../matching/evidence.js';
import type { TracklistGroup } from './grouping.js';

export interface DeciderInput { album: AlbumEvidence; groups: TracklistGroup[] }
export interface DeciderAnswer {
  /** group label → probability; validated by decideFromProbabilities, not trusted */
  probabilities: Record<string, number>;
  /** the dated model name the provider answered with */
  model: string;
  inputTokens: number;
  requestBytes: number;
  raw: unknown;
}
export interface Decider { id: string; specHash: string; ask(input: DeciderInput, opts: { model: string }): Promise<DeciderAnswer> }
