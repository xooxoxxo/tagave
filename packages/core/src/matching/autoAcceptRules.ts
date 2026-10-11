import {
  compareEdition, everyCheckAgrees, matchPercent, statusTag, autoAcceptRulesSchema, DEFAULT_AUTO_ACCEPT_RULES,
  type AutoAcceptRules, type ComparableAlbum, type ComparableEdition,
} from '@liner/shared';

/**
 * The owner's auto-accept rules (Review matches › Auto-accept), as one pure
 * decision over an album and its editions. The worker applies it to albums
 * the matcher leaves for review and to the queue on request; the API runs it
 * as a dry run for the live count in the rules dialog.
 */

export interface RuleCandidate extends ComparableEdition {
  id: string;
  distance: number;
  /** 'musicbrainz' | 'discogs' (releases.source_of_truth) */
  provider: string;
  /** MusicBrainz release status; Discogs has none */
  status: string | null;
}

export type AutoAcceptDecision<C extends RuleCandidate = RuleCandidate> =
  | { accept: true; candidate: C; percent: number; reason: string }
  | { accept: false; reason: string };

const PROVIDER_NAME: Record<string, string> = { musicbrainz: 'MusicBrainz', discogs: 'Discogs' };

/**
 * Decide one album:
 *
 * 1. Prefer source: when the preferred provider has an edition that passes
 *    the checks, only that provider's editions are compared (the same
 *    edition listed on both would otherwise never be a clear winner).
 * 2. The winner is the best-scoring edition that passes the checks (official
 *    only: no release status other than Official; every check agrees: every
 *    comparable row of the comparison agrees).
 * 3. It must reach the minimum match percent, and — when a gap is set — be
 *    that many points ahead of the best other edition in the field, whether
 *    or not that one passed the checks (a better bootleg is still a rival).
 *
 * `rules.enabled` is not consulted: the worker checks the switch, the dry
 * run shows what the rules would do once switched on.
 */
export function evaluateAutoAccept<C extends RuleCandidate>(
  rules: AutoAcceptRules,
  album: ComparableAlbum,
  candidates: C[],
): AutoAcceptDecision<C> {
  if (candidates.length === 0) return { accept: false, reason: 'no editions' };

  const passes = (c: C): boolean => {
    if (rules.officialOnly && statusTag(c.status)) return false;
    if (rules.allChecksAgree && !everyCheckAgrees(compareEdition(album, c))) return false;
    return true;
  };

  let field = candidates;
  if (rules.preferSource !== 'either') {
    const preferred = candidates.filter((c) => c.provider === rules.preferSource);
    if (preferred.some(passes)) field = preferred;
  }
  const ranked = [...field].sort((a, b) => a.distance - b.distance);
  const winner = ranked.find(passes);
  if (!winner) {
    return { accept: false, reason: rules.officialOnly ? 'no official edition passes the checks' : 'no edition passes the checks' };
  }
  const percent = matchPercent(winner.distance);
  if (percent < rules.minMatch) return { accept: false, reason: `best edition ${percent}% is under ${rules.minMatch}%` };

  let gapNote = '';
  if (rules.clearWinnerGap > 0) {
    const rival = ranked.find((c) => c !== winner);
    if (rival) {
      const gap = percent - matchPercent(rival.distance);
      if (gap < rules.clearWinnerGap) return { accept: false, reason: `next edition is ${gap} points behind, under ${rules.clearWinnerGap}` };
      gapNote = `, ${gap} points ahead`;
    } else {
      gapNote = ', only edition';
    }
  }
  const checks = rules.allChecksAgree ? ', every check agrees' : '';
  const official = rules.officialOnly ? ', official' : '';
  const source = PROVIDER_NAME[winner.provider] ?? winner.provider;
  return {
    accept: true,
    candidate: winner,
    percent,
    reason: `${percent}% match${checks}${official}${gapNote} (${source})`,
  };
}

/**
 * Stored rules (auto_accept_rules row) as validated rules: no row means the
 * defaults (off); a row that no longer validates is treated as off rather
 * than guessed at.
 */
export function rulesFromStored(row: {
  enabled: boolean; minMatch: number; allChecksAgree: boolean; clearWinnerGap: number; preferSource: string; officialOnly: boolean;
} | null): AutoAcceptRules {
  if (!row) return DEFAULT_AUTO_ACCEPT_RULES;
  const parsed = autoAcceptRulesSchema.safeParse({
    enabled: row.enabled,
    minMatch: row.minMatch,
    allChecksAgree: row.allChecksAgree,
    clearWinnerGap: row.clearWinnerGap,
    preferSource: row.preferSource,
    officialOnly: row.officialOnly,
  });
  return parsed.success ? parsed.data : { ...DEFAULT_AUTO_ACCEPT_RULES, enabled: false };
}
