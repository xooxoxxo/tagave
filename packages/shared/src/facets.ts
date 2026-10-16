/**
 * Facets and modules as the web app sees them (Facets and Connectors design
 * §4): GET /api/v1/facets says which facets are available, so the app hides
 * what is off; the Music Connections row of Settings › Modules; the
 * wantlist suggestions panel. api › routes/facets.ts and routes/mcModule.ts
 * answer with these.
 */
import { z } from 'zod';

export interface FacetStateView {
  /** `<kind>.<facet>@<major>` */
  id: string;
  available: boolean;
  version: string | null;
  providers: string[];
}

export interface ModuleStateView {
  id: string;
  enabled: boolean;
  builtIn: boolean;
  /** facets it reads that no module on gives */
  needs: string[];
  refused: string[];
}

export interface FacetsView {
  facets: FacetStateView[];
  modules: ModuleStateView[];
}

/** Settings › Modules: the Music Connections row (a setting, not a container). */
export interface McModuleView {
  enabled: boolean;
  /** links made by anyone on this install, and what they brought */
  links: number;
  landed: number;
  /** album MBIDs it filled that nobody has confirmed */
  fills: number;
}

export const mcModuleSchema = z.object({ enabled: z.boolean() });
export const mcRemoveDataSchema = z.object({
  /** keep the album MBIDs it filled (they become core's own) */
  keepFills: z.boolean().optional(),
});

export interface WantlistSuggestionView {
  id: string;
  linkId: string;
  /** the app that suggested it (its manifest's service) */
  service: string;
  artist: string;
  title: string;
  /** the album here, once tagave has it */
  releaseGroupId: string | null;
  rgMbid: string | null;
  /** the remote's own sentence */
  reason: string;
  score: number | null;
  suggestedAt: string;
  decision: 'accepted' | 'dismissed' | null;
  decidedAt: string | null;
}

export interface WantlistEntryView {
  id: string;
  artist: string | null;
  title: string | null;
  releaseGroupId: string | null;
  releaseGroupMbid: string | null;
  discogsReleaseId: number | null;
  dateAdded: string | null;
}

export interface WantlistView {
  /** false when Music Connections is off (the panel hides) */
  available: boolean;
  suggestions: WantlistSuggestionView[];
  wantlist: WantlistEntryView[];
}

export const wantlistDecisionSchema = z.object({
  decision: z.enum(['accepted', 'dismissed']),
  /** the library an accepted album joins the wantlist of (the caller's current one) */
  libraryId: z.string().uuid(),
});
export type WantlistDecision = z.infer<typeof wantlistDecisionSchema>['decision'];
