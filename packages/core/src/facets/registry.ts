/**
 * The facet registry (Facets and Connectors design §4): which modules are on,
 * which facets are available, and the only way one module reads another's
 * data (facets.get / getMany).
 *
 * Compatibility, checked at boot and when a module is turned on:
 *
 *   same major, provider minor ≥ the consumer's range   the feature is on
 *   no enabled provider                                 the feature is off; "needs <facet>"
 *   only another major, and no cast                     turning the consumer on is refused, naming the facet
 *   two providers                                       both are used, each value tagged by its source
 *
 * Values are checked against the facet's schema on the way out; a value
 * that fails it is left out (fail closed), as is a provider of another
 * major that no cast joins.
 */
import { parseFacetId, parseRange, parseVersion, type CastDescriptor, type FacetDescriptor, type FacetScope, type ModuleContext, type ModuleManifest } from './define.js';

export interface EntityRef {
  kind: string;
  id: string;
}

/** Who asks: their library and person; facets.get passes on only what the facet's scope allows. */
export interface FacetContext extends ModuleContext {
  libraryId: string | null;
  userId: string | null;
}

/** What a provider's reader is handed: global sees neither, library the library, person both. */
export type ScopeArgs = { scope: 'global' } | { scope: 'library'; libraryId: string } | { scope: 'person'; libraryId: string; userId: string };

export interface FacetSource {
  module: string;
  /** the link or account, when the module has several (mc: the link id) */
  ref: string | null;
  /** shown beside the value, e.g. "review-gatherer" */
  label: string;
  /** for a `one` facet's pick: what a person set, what the files carry, or a module's */
  kind?: 'person' | 'embedded' | 'module';
}

export interface FacetValue {
  source: FacetSource;
  data: unknown;
  updatedAt: string | null;
}

export type FacetReader = (entities: EntityRef[], scope: ScopeArgs) => Promise<Map<string, FacetValue[]>>;

export interface FacetResult {
  available: boolean;
  /** major.minor served (the facet's own) */
  version: string | null;
  values: FacetValue[];
  pick?: FacetValue | null;
}

export interface ModuleState {
  id: string;
  enabled: boolean;
  builtIn: boolean;
  /** facets it reads that no enabled provider gives (its features are off) */
  needs: string[];
  /** why it may not be on (a major nobody casts) */
  refused: string[];
}

export interface FacetState {
  id: string;
  available: boolean;
  version: string | null;
  providers: string[];
}

export interface Registry {
  facets: ReadonlyMap<string, FacetDescriptor>;
  modules: ReadonlyMap<string, ModuleManifest>;
  isEnabled(moduleId: string, ctx: ModuleContext): boolean;
  /** Turning `moduleId` on (or keeping it on) with the others as they are. */
  canTurnOn(moduleId: string, ctx: ModuleContext): { ok: true } | { ok: false; reason: string };
  available(facetId: string, ctx: ModuleContext): boolean;
  state(ctx: ModuleContext): { modules: ModuleState[]; facets: FacetState[] };
  /** Boot check: facets a module names that nobody defines, and duplicate providers' versions. */
  problems(): string[];
}

const nameOf = (id: string) => parseFacetId(id).name;

export function createRegistry(opts: { facets: readonly FacetDescriptor[]; modules: readonly ModuleManifest[]; casts?: readonly CastDescriptor[] }): Registry {
  const facets = new Map<string, FacetDescriptor>();
  for (const f of opts.facets) {
    if (facets.has(f.id)) throw new Error(`facet defined twice: ${f.id}`);
    facets.set(f.id, f);
  }
  const modules = new Map<string, ModuleManifest>();
  for (const m of opts.modules) {
    if (modules.has(m.id)) throw new Error(`module listed twice: ${m.id}`);
    modules.set(m.id, m);
  }
  const casts = opts.casts ?? [];
  const castJoins = (name: string, fromMajor: number, toMajor: number) =>
    fromMajor === toMajor || casts.some((c) => {
      const a = parseFacetId(c.from);
      const b = parseFacetId(c.to);
      if (a.name !== name || b.name !== name) return false;
      return (a.major === fromMajor && b.major === toMajor) || (c.down !== undefined && b.major === fromMajor && a.major === toMajor);
    });

  const isEnabled = (id: string, ctx: ModuleContext): boolean => {
    const m = modules.get(id);
    if (!m) return false;
    return m.builtIn || m.enabled(ctx);
  };

  /** Enabled providers of a facet name, with their versions. */
  const providersOf = (name: string, ctx: ModuleContext, without?: string, plus?: string) => {
    const out: Array<{ module: string; major: number; minor: number }> = [];
    for (const m of modules.values()) {
      const on = m.id === plus || (m.id !== without && isEnabled(m.id, ctx));
      if (!on) continue;
      for (const p of m.provides) if (p.facet === name) out.push({ module: m.id, ...parseVersion(p.version) });
    }
    return out;
  };

  /** Whether one consumer range is met: same major (or a cast) and a minor high enough. */
  const meets = (range: string, p: { major: number; minor: number }, name: string) => {
    const r = parseRange(range);
    if (p.major === r.major) return p.minor >= r.minor;
    return castJoins(name, p.major, r.major);
  };

  const consumerProblems = (m: ModuleManifest, ctx: ModuleContext, plus?: string) => {
    const needs: string[] = [];
    const refused: string[] = [];
    for (const c of m.consumes) {
      const ps = providersOf(c.facet, ctx, undefined, plus).filter((p) => p.module !== m.id);
      const r = parseRange(c.range);
      if (ps.length === 0) needs.push(`${c.facet}@${r.major}`);
      else if (!ps.some((p) => meets(c.range, p, c.facet))) {
        const other = ps.find((p) => p.major !== r.major);
        if (other) refused.push(`${m.id} reads ${c.facet}@${r.major} but ${other.module} gives ${c.facet}@${other.major} and no cast joins them`);
        else needs.push(`${c.facet}@${r.major} (${c.range} or later)`);
      }
    }
    return { needs, refused };
  };

  const canTurnOn = (id: string, ctx: ModuleContext): { ok: true } | { ok: false; reason: string } => {
    const m = modules.get(id);
    if (!m) return { ok: false, reason: `no module ${id}` };
    // as a consumer: a provider of another major that nobody casts
    const own = consumerProblems(m, ctx, id);
    if (own.refused.length) return { ok: false, reason: own.refused[0]! };
    // as a provider: an enabled consumer reading another major of what it gives
    for (const p of m.provides) {
      const v = parseVersion(p.version);
      for (const c of modules.values()) {
        if (c.id === id || !isEnabled(c.id, ctx)) continue;
        for (const need of c.consumes) {
          if (need.facet !== p.facet) continue;
          const r = parseRange(need.range);
          if (v.major !== r.major && !castJoins(p.facet, v.major, r.major)) {
            return { ok: false, reason: `${c.id} reads ${p.facet}@${r.major} but ${id} gives ${p.facet}@${v.major} and no cast joins them` };
          }
        }
      }
    }
    return { ok: true };
  };

  const available = (facetId: string, ctx: ModuleContext): boolean => {
    const f = facets.get(facetId);
    if (!f) return false;
    return providersOf(f.name, ctx).some((p) => p.major === f.major || castJoins(f.name, p.major, f.major));
  };

  return {
    facets,
    modules,
    isEnabled,
    canTurnOn,
    available,
    state(ctx) {
      const ms: ModuleState[] = [...modules.values()].map((m) => {
        const enabled = isEnabled(m.id, ctx);
        const p = consumerProblems(m, ctx);
        return { id: m.id, enabled, builtIn: m.builtIn, needs: p.needs, refused: p.refused };
      });
      const fs: FacetState[] = [...facets.values()].map((f) => {
        const ps = providersOf(f.name, ctx).filter((p) => p.major === f.major || castJoins(f.name, p.major, f.major));
        return { id: f.id, available: ps.length > 0, version: ps.length > 0 ? f.version : null, providers: ps.map((p) => p.module) };
      });
      return { modules: ms, facets: fs };
    },
    problems() {
      const out: string[] = [];
      const known = new Set([...facets.values()].map((f) => f.name));
      for (const m of modules.values()) {
        for (const p of m.provides) if (!known.has(p.facet)) out.push(`${m.id} provides ${p.facet}, which no facet defines`);
        for (const c of m.consumes) if (!known.has(c.facet)) out.push(`${m.id} consumes ${c.facet}, which no facet defines`);
      }
      return out;
    },
  };
}

/** The reader's view of the caller: only what the facet's scope allows, or null when the caller lacks it. */
export function scopeArgs(scope: FacetScope, ctx: { libraryId: string | null; userId: string | null }): ScopeArgs | null {
  if (scope === 'global') return { scope: 'global' };
  if (!ctx.libraryId) return null;
  if (scope === 'library') return { scope: 'library', libraryId: ctx.libraryId };
  if (!ctx.userId) return null;
  return { scope: 'person', libraryId: ctx.libraryId, userId: ctx.userId };
}

const PICK_ORDER: Record<string, number> = { person: 0, embedded: 1, module: 2 };

export interface Facets {
  available(facetId: string, ctx: ModuleContext): boolean;
  get(ctx: FacetContext, entity: EntityRef, facetId: string): Promise<FacetResult>;
  getMany(ctx: FacetContext, entities: EntityRef[], facetId: string): Promise<Map<string, FacetResult>>;
}

/**
 * facets.get over a registry and the providers' readers
 * (`readers[moduleId][facetId]`). Readers of modules that are off are not
 * called; values are schema-checked and tagged with their source.
 */
export function createFacets(registry: Registry, readers: Record<string, Partial<Record<string, FacetReader>>>): Facets {
  const getMany = async (ctx: FacetContext, entities: EntityRef[], facetId: string): Promise<Map<string, FacetResult>> => {
    const f = registry.facets.get(facetId);
    const out = new Map<string, FacetResult>();
    const empty = (available: boolean): FacetResult => ({ available, version: available && f ? f.version : null, values: [], ...(f?.cardinality === 'one' ? { pick: null } : {}) });
    if (!f || !registry.available(facetId, ctx)) {
      for (const e of entities) out.set(e.id, empty(false));
      return out;
    }
    const args = scopeArgs(f.scope, ctx);
    const wanted = entities.filter((e) => e.kind === f.kind);
    for (const e of entities) out.set(e.id, empty(true));
    if (!args || wanted.length === 0) return out;
    for (const m of registry.modules.values()) {
      if (!registry.isEnabled(m.id, ctx)) continue;
      const p = m.provides.find((x) => x.facet === f.name);
      if (!p || parseVersion(p.version).major !== f.major) continue;
      const read = readers[m.id]?.[facetId];
      if (!read) continue;
      const got = await read(wanted, args);
      for (const [entityId, values] of got) {
        const r = out.get(entityId);
        if (!r) continue;
        for (const v of values) {
          const parsed = f.schema.safeParse(v.data);
          if (!parsed.success) continue;
          r.values.push({ ...v, data: parsed.data, source: { ...v.source, module: m.id } });
        }
      }
    }
    if (f.cardinality === 'one') {
      for (const r of out.values()) {
        r.pick = [...r.values].sort((a, b) => (PICK_ORDER[a.source.kind ?? 'module'] ?? 2) - (PICK_ORDER[b.source.kind ?? 'module'] ?? 2))[0] ?? null;
      }
    }
    return out;
  };
  return {
    available: (id, ctx) => registry.available(id, ctx),
    getMany,
    get: async (ctx, entity, facetId) => (await getMany(ctx, [entity], facetId)).get(entity.id)!,
  };
}

export { nameOf as facetNameOf };
