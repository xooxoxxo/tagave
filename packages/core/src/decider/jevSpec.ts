/**
 * The question tagave asks Jev, versioned and hashed. Everything that can
 * change an answer or a decision is in here (wording, the margin, the
 * bands and cut-off, the grouping tolerances, the request layout version,
 * the placeholders), so a decision names exactly what it was made under.
 *
 * The placeholders stand in for local values that did not come from the
 * files' tags (a title made from a file name, a year read from a folder
 * name): those values are never sent, the placeholder goes instead.
 */
import { createHash } from 'node:crypto';
import { stableJson } from '../matching/evidence.js';
import { GROUPING_DEFAULTS } from './grouping.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const JEV_SPEC = deepFreeze({
  id: 'tagave-tracklist',
  version: 1,
  margin: 0.3,
  cutoff: 0.9,
  bands: [{ id: 'p99', min: 0.99 }, { id: 'p97', min: 0.97 }, { id: 'p95', min: 0.95 }, { id: 'p90', min: 0.9 }],
  grouping: GROUPING_DEFAULTS,
  stateTemplate: 1,
  placeholders: { title: 'track {n}', year: 'year unknown' },
  task: 'Decide which of the tracklists the local files are a copy of. A tracklist is one release as music databases list it; the local files were ripped or bought by their owner and tagged by hand, so tags can be incomplete.',
  instructions: 'The local files (state.local) are a copy of tracklist {label} (state.tracklists.{label}): the same songs in the same order on the same discs. Spelling, capitalisation, missing lengths, lengths a few seconds apart and remastering do not matter. A different song list, extra or missing tracks, a live or different recording, or another album do. A title shown as "track N" or a year shown as "year unknown" was not readable and says nothing either way.',
  criteria: { true: 'The local files are this tracklist.', false: 'The local files are not this tracklist, or it cannot be told.' },
} as const);

export type JevSpec = typeof JEV_SPEC;
export type BandId = (typeof JEV_SPEC.bands)[number]['id'];

/** `<id>-v<version>@<12 hex>`: sha-256 over the whole spec, keys sorted, so key order never matters. */
export function jevSpecHash(spec: JevSpec = JEV_SPEC): string {
  return `${spec.id}-v${spec.version}@${createHash('sha256').update(stableJson(spec)).digest('hex').slice(0, 12)}`;
}

const isProbability = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;

/** The highest band whose floor the probability reaches; null under the cut-off or for a value that is not a probability. */
export function bandOf(p: number, spec: JevSpec = JEV_SPEC): BandId | null {
  if (!isProbability(p) || p < spec.cutoff) return null;
  let best: { id: BandId; min: number } | null = null;
  for (const b of spec.bands) if (p >= b.min && (!best || b.min > best.min)) best = b;
  return best?.id ?? null;
}

export type JevDecision =
  | { kind: 'pick'; label: string; probability: number; margin: number; band: BandId }
  | {
      kind: 'none';
      /** invalid_answer: the answer was not one probability in 0..1 for each group asked about */
      reason: 'no_groups' | 'below_cutoff' | 'margin' | 'invalid_answer';
      label: string | null;
      probability: number | null;
      margin: number | null;
    };

const r4 = (x: number) => Math.round(x * 10000) / 10000;

const invalid = (): JevDecision => ({ kind: 'none', reason: 'invalid_answer', label: null, probability: null, margin: null });

/**
 * The decision from Jev's answer: one probability per group, each the answer
 * to its own true/false question, so they need not sum to 1. The most
 * probable group is picked when it reaches the cut-off and beats the next
 * group by the margin (a single group's margin is to nothing). The margin is
 * rounded to 4 places before the comparison, so float noise never fails an
 * exact margin; the probability is passed through as given.
 *
 * An answer that is not a set of probabilities (not an object, an empty
 * label, a value that is not a finite number in 0..1, or, when `labels`
 * names the groups asked about, a missing or an extra group) is
 * `none` / `invalid_answer` with no label and no number. It never throws and
 * never yields a pick, so a bad answer leaves the album in review and no bad
 * number can reach a stored decision.
 */
export function decideFromProbabilities(
  probs: Record<string, number>,
  spec: JevSpec = JEV_SPEC,
  opts: { labels?: readonly string[] } = {},
): JevDecision {
  if (!probs || typeof probs !== 'object' || Array.isArray(probs)) return invalid();
  const entries = Object.entries(probs as Record<string, unknown>);
  for (const [label, p] of entries) if (label === '' || !isProbability(p)) return invalid();
  if (opts.labels) {
    const asked = new Set(opts.labels);
    if (asked.size !== opts.labels.length || asked.size !== entries.length || entries.some(([label]) => !asked.has(label))) return invalid();
  }
  const ranked = (entries as Array<[string, number]>).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const top = ranked[0];
  if (!top) return { kind: 'none', reason: 'no_groups', label: null, probability: null, margin: null };
  const [label, p] = top;
  const margin = r4(p - (ranked[1]?.[1] ?? 0));
  const band = bandOf(p, spec);
  if (p < spec.cutoff || band === null) return { kind: 'none', reason: 'below_cutoff', label, probability: p, margin };
  if (margin < spec.margin) return { kind: 'none', reason: 'margin', label, probability: p, margin };
  return { kind: 'pick', label, probability: p, margin, band };
}
