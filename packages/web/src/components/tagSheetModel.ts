/**
 * The Tag sheet's words and payload (TagSheet.tsx), apart from React so they
 * can be tested: each row's one-line summary, the plan's suggested name, the
 * scope and policy the plan is created with, and what the one primary
 * button does.
 */
import type { CreateTagPlan, TagPlanScope } from '@tagave/shared';
import { PRESETS, type PolicyState, type ScopeState } from './tagPlanControls';

/** The album's matched release, as the album detail gives it. */
export interface ReleaseFacts {
  title: string;
  date: string | null;
  country: string | null;
  labels: Array<{ name: string }> | null;
}

/** "OK Computer (1997, GB, Parlophone)". */
export function releaseSummary(r: ReleaseFacts | null | undefined): string | null {
  if (!r) return null;
  const facts = [r.date ? r.date.slice(0, 4) : null, r.country, r.labels?.[0]?.name ?? null].filter(Boolean);
  return facts.length > 0 ? `${r.title} (${facts.join(', ')})` : r.title;
}

/** What the plan covers, in a few words; null until something is picked. */
export function scopeSummary(s: ScopeState): string | null {
  switch (s.scopeType) {
    case 'artist': return s.artistName ?? null;
    case 'albumIds': {
      const ids = s.albumIds ?? [];
      if (ids.length === 0) return null;
      if (ids.length === 1) return s.albumLabels?.[ids[0]!] ?? '1 album';
      return `${ids.length} albums`;
    }
    case 'filterQuery': return Object.keys(s.filterQuery ?? {}).length > 0 ? s.filterText?.trim() || 'Filter' : null;
    case 'library': return 'Entire library';
    default: return null;
  }
}

/** A plan is named after what it covers unless the owner types a name. */
export function suggestedName(s: ScopeState): string {
  switch (s.scopeType) {
    case 'artist': return s.artistName ? `${s.artistName} tags` : 'Artist tags';
    case 'albumIds': {
      const ids = s.albumIds ?? [];
      if (ids.length === 1) return `${s.albumLabels?.[ids[0]!] ?? '1 album'} tags`;
      return `Tags for ${ids.length} albums`;
    }
    case 'filterQuery': return 'Tags for filtered albums';
    case 'library': return 'Whole library tags';
    default: return 'New tag plan';
  }
}

/** "Canonical IDs + fill · ID3 v2.4". */
export function policySummary(p: PolicyState): string {
  return `${PRESETS.find((x) => x.id === p.preset)?.label ?? p.preset} · ID3 v${p.id3Version}`;
}

export function scopeOf(s: ScopeState): TagPlanScope | null {
  switch (s.scopeType) {
    case 'library': return { type: 'library' };
    case 'artist': return s.artistId ? { type: 'artist', artistId: s.artistId } : null;
    case 'albumIds': return s.albumIds?.length ? { type: 'albumIds', albumIds: s.albumIds } : null;
    case 'filterQuery': return s.filterQuery && Object.keys(s.filterQuery).length > 0 ? { type: 'filterQuery', filterQuery: s.filterQuery } : null;
    default: return null;
  }
}

/**
 * The new plan: its name, scope and policy. Organize is sent only when the
 * owner changed it (the server's default follows the saved naming rules);
 * Split first only when turned off (the server splits unless told not to).
 */
export function createPayload(input: { scope: ScopeState; policy: PolicyState; name: string; organize: boolean | null; split: boolean }): CreateTagPlan | null {
  const scope = scopeOf(input.scope);
  if (!scope) return null;
  return {
    name: input.name.trim() || suggestedName(input.scope),
    scope,
    policy: {
      preset: input.policy.preset,
      id3Version: input.policy.id3Version,
      multiValueSeparator: input.policy.multiValueSeparator,
      ...(input.policy.overrides ? { overrides: input.policy.overrides } : {}),
      ...(input.organize === null ? {} : { organize: input.organize }),
      ...(input.split ? {} : { split: false }),
    },
  };
}

export type PrimaryAction =
  | { kind: 'preview'; label: 'Preview' }
  | { kind: 'add'; label: 'Add to plan' }
  | { kind: 'pick-release'; label: 'Pick a release' }
  | { kind: 'pick-scope'; label: 'Preview' };

/**
 * The one primary button: an album with no match picks a release first (no
 * dead end); nothing chosen yet opens what the plan covers; adding to an
 * open plan says so; otherwise Preview.
 */
export function primaryAction(input: { unmatched: boolean; scopeReady: boolean; addTo: boolean }): PrimaryAction {
  if (input.unmatched) return { kind: 'pick-release', label: 'Pick a release' };
  if (!input.scopeReady) return { kind: 'pick-scope', label: 'Preview' };
  if (input.addTo) return { kind: 'add', label: 'Add to plan' };
  return { kind: 'preview', label: 'Preview' };
}

/**
 * Enter on the sheet is its primary action, except where Enter already does
 * something: a button or link (it presses it), a list, a search box (it
 * searches). In the name field or on a choice it creates the plan, as a form.
 */
export function enterIsPrimary(target: { tagName: string; type?: string } | null): boolean {
  if (!target) return true;
  const tag = target.tagName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (tag === 'INPUT' && target.type === 'search') return false;
  return true;
}
