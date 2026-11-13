/**
 * The local decider (vault "tagave - Autotagger Local Decider"): a model
 * trained on the owner's own decisions scores each tracklist group of an
 * album, on this machine. Nothing is sent anywhere and nothing is billed.
 *
 * build groups the album's candidates as training measured them
 * (localDeciderGroups: every candidate with evidence, each release once at
 * its best distance, no cap) and turns each group into its feature row
 * (groupFeatures); ask scores the rows with the stored model. The answer
 * then goes through decideFromProbabilities and pickEdition like any other
 * decider's.
 *
 * An album whose candidate set is not whole (a scorable candidate without
 * evidence) or that has none is not decided, as for every decider.
 */
import type { CandidateEvidence, EvidenceCandidate } from '../matching/evidence.js';
import { NotSendableError } from './jevPayload.js';
import { jevSpecHash } from './jevSpec.js';
import { groupFeatures, type FeatureRow, type LocalCandidate } from './localFeatures.js';
import { calibratedProbability, type LocalModel } from './localModel.js';
import { localDeciderGroups, numericBreakdown } from './localTrain.js';
import type { Decider, DeciderRequest } from './types.js';

/** The local decider's id (decider_runs.decider_id, decider_models.decider). */
export const LOCAL_DECIDER_ID = 'local';

/** What a local decider's build hands its ask: one feature row per group, nothing else. */
export interface LocalPayload { features: FeatureRow[] }

/** The candidate fields the local decider reads beyond the evidence (the stored loader gives them). */
interface LocalExtra { breakdown?: unknown; provider?: 'musicbrainz' | 'discogs' }

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A Decider for one stored model. `version` is the model's version
 * (modelVersion), which every answer names, so a run, its decisions and
 * their batches know which model decided.
 */
export function localDecider(model: LocalModel, version: string): Decider {
  return {
    id: LOCAL_DECIDER_ID,
    // the same grouping, bands and margin as every decider: the decision is decideFromProbabilities'
    specHash: jevSpecHash(),
    billing: 'free',
    build<C extends EvidenceCandidate>(album: Parameters<Decider['build']>[0], candidates: C[], opts: Parameters<Decider['build']>[2]): DeciderRequest<C> {
      if (opts.partial) throw new NotSendableError('partial_evidence');
      const withEvidence = candidates.filter((c): c is C & { evidence: CandidateEvidence } => c.evidence !== null && c.evidence !== undefined);
      if (withEvidence.length === 0) throw new NotSendableError('no_candidates');
      // each release once, at its best distance, in distance order
      const seen = new Set<string>();
      const once = [...withEvidence]
        .sort((a, b) => a.distance - b.distance || byId(a.releaseId, b.releaseId))
        .filter((c) => (seen.has(c.releaseId) ? false : (seen.add(c.releaseId), true)));
      const groups = localDeciderGroups(album, once);
      const rows: LocalCandidate[] = once.map((c) => {
        const extra = c as unknown as LocalExtra;
        return {
          releaseId: c.releaseId,
          distance: c.distance,
          breakdown: numericBreakdown(extra.breakdown ?? null),
          acoustidCoverage: c.acoustidCoverage,
          provider: extra.provider === 'discogs' ? 'discogs' : 'musicbrainz',
        };
      });
      const payload: LocalPayload = { features: groupFeatures(groups, rows) };
      return { payload, bytes: 0, groups, sent: groups, labels: groups.map((g) => g.label), candidates: once };
    },
    async ask(input, { model: asked }) {
      if (asked !== version) throw new Error(`local decider: asked for ${asked}, this is ${version}`);
      const { features } = input.payload as LocalPayload;
      const probabilities: Record<string, number> = {};
      for (const row of features) probabilities[row.label] = calibratedProbability(model, row.features);
      return { probabilities, model: version, inputTokens: 0, requestBytes: 0, raw: null };
    },
  };
}
