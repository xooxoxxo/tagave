/**
 * Facets (Facets and Connectors design §3-§4, §7): named, versioned data a
 * module adds about a core entity. Core owns who an entity is; a facet says
 * something about it (critic scores of an album, whether a track plays here).
 *
 *   name       `<kind>.<facet>`, e.g. album.critic-scores
 *   id         `<name>@<major>`, e.g. album.critic-scores@1
 *   version    `<major>.<minor>`: a minor adds an optional field; a major
 *              removes, renames or retypes one, tightens a bound, or changes
 *              a unit or a meaning. Consumers ignore unknown fields.
 *   scope      global (about the entity), library (what this library has),
 *              person (one person's data); facets.get filters by it
 *   cardinality many: every source's value; one: also a pick (person-set,
 *              then embedded, then module)
 *   schema     zod: what one value's data looks like (entity identity left
 *              out, the entity id is the key)
 */
import type { z } from 'zod';

export const ENTITY_KINDS = ['artist', 'album', 'release', 'track'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export type FacetScope = 'global' | 'library' | 'person';
export type Cardinality = 'one' | 'many';

const NAME_RE = /^(artist|album|release|track)\.[a-z][a-z0-9-]{0,62}$/;
const VERSION_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})$/;
const ID_RE = /^((?:artist|album|release|track)\.[a-z][a-z0-9-]{0,62})@(0|[1-9]\d{0,3})$/;
const RANGE_RE = /^\^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})$/;

export interface FacetDescriptor {
  kind: EntityKind;
  name: string;
  /** `<major>.<minor>` */
  version: string;
  major: number;
  minor: number;
  /** `<name>@<major>` */
  id: string;
  scope: FacetScope;
  cardinality: Cardinality;
  schema: z.ZodType;
}

export function parseVersion(v: string): { major: number; minor: number } {
  const m = VERSION_RE.exec(v);
  if (!m) throw new Error(`not a facet version (major.minor): ${v}`);
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/** `album.critic-scores@1` → its name and major. */
export function parseFacetId(id: string): { name: string; major: number } {
  const m = ID_RE.exec(id);
  if (!m) throw new Error(`not a facet id (<kind>.<facet>@<major>): ${id}`);
  return { name: m[1]!, major: Number(m[2]) };
}

/** `^1.2` → the major it pins and the lowest minor it accepts. */
export function parseRange(range: string): { major: number; minor: number } {
  const m = RANGE_RE.exec(range);
  if (!m) throw new Error(`not a facet range (^major.minor): ${range}`);
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function defineFacet(d: { name: string; version: string; scope: FacetScope; cardinality: Cardinality; schema: z.ZodType }): FacetDescriptor {
  if (!NAME_RE.test(d.name)) throw new Error(`not a facet name (<kind>.<facet>): ${d.name}`);
  const { major, minor } = parseVersion(d.version);
  return { ...d, kind: d.name.split('.')[0] as EntityKind, major, minor, id: `${d.name}@${major}` };
}

/** What a module's `enabled` reads: the install's switches. */
export interface ModuleContext {
  settings: { mcEnabled: boolean };
  /** TAGAVE_PLAYER_URL, when the player runs */
  playerUrl: string | null;
}

export interface ModuleManifest {
  id: string;
  /** semver of the module */
  version: string;
  /** Always on (library, collection, reviews): cannot be turned off. */
  builtIn: boolean;
  provides: ReadonlyArray<{ facet: string; version: string; table?: string }>;
  consumes: ReadonlyArray<{ facet: string; range: string }>;
  /** Core fields the module may fill when they are empty (identity_fills). */
  gapFills: ReadonlyArray<{ kind: EntityKind; field: string }>;
  jobs: readonly string[];
  /** Every table the module owns: uninstall clears them; a schema test checks the prefix. */
  tables: readonly string[];
  /** Table-name prefix the module owns (mc_, player_), if any. */
  prefix: string | null;
  /**
   * Its values are relayed from another app (mc: what a linked app sent), so
   * a value's source label names the relay, not the outlet. Built-in modules
   * read their sources themselves (false).
   */
  relays: boolean;
  enabled(ctx: ModuleContext): boolean;
}

const MODULE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function defineModule(m: Omit<ModuleManifest, 'builtIn' | 'gapFills' | 'jobs' | 'tables' | 'prefix' | 'relays'> & Partial<Pick<ModuleManifest, 'builtIn' | 'gapFills' | 'jobs' | 'tables' | 'prefix' | 'relays'>>): ModuleManifest {
  if (!MODULE_ID_RE.test(m.id)) throw new Error(`not a module id: ${m.id}`);
  for (const p of m.provides) {
    if (!NAME_RE.test(p.facet)) throw new Error(`${m.id}: provides a facet by name, not id: ${p.facet}`);
    parseVersion(p.version);
  }
  for (const c of m.consumes) {
    if (!NAME_RE.test(c.facet)) throw new Error(`${m.id}: consumes a facet by name, not id: ${c.facet}`);
    parseRange(c.range);
  }
  return { builtIn: false, gapFills: [], jobs: [], tables: [], prefix: null, relays: false, ...m };
}

/**
 * A cast between two majors of one facet (§7). Required when a major ships
 * while an installed consumer or a linked remote still reads the old one;
 * `down` returning null leaves the value out for old consumers. v1 ships none.
 */
export interface CastDescriptor {
  from: string;
  to: string;
  up(v: unknown): unknown;
  down?(v: unknown): unknown | null;
}

export function defineCast(c: CastDescriptor): CastDescriptor {
  const a = parseFacetId(c.from);
  const b = parseFacetId(c.to);
  if (a.name !== b.name || a.major === b.major) throw new Error(`a cast joins two majors of one facet: ${c.from} → ${c.to}`);
  return c;
}
