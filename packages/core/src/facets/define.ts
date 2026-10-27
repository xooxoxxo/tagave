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

/**
 * The core API this build offers apps and modules (`<major>.<minor>`). A
 * manifest's `coreApi` range must accept it, or the manifest is refused when
 * it is defined: a module built for another major never ships.
 */
export const CORE_API = '1.0';

/** `1.4.2` (or `1.4`) meets `^1.2`: the same major, and a minor at least as high. */
export function versionMeets(version: string, range: string): boolean {
  const r = parseRange(range);
  const m = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})(?:\.\d+)?(?:[-+].*)?$/.exec(version);
  if (!m) return false;
  return Number(m[1]) === r.major && Number(m[2]) >= r.minor;
}

/** What a module's `enabled` reads: the install's switches. */
export interface ModuleContext {
  /**
   * Whether app or module `id` is turned on in the module ledger
   * (installed_modules, Settings › Modules). An id with no row is off.
   */
  enabled(id: string): boolean;
  /** TAGAVE_PLAYER_URL, when the player runs */
  playerUrl: string | null;
}

/** A ModuleContext over the ledger's switches (@tagave/db moduleSwitches). */
export function moduleContext(switches: Readonly<Record<string, boolean>>, playerUrl: string | null = null): ModuleContext {
  const on = { ...switches };
  return { enabled: (id) => on[id] === true, playerUrl };
}

/**
 * How a module runs: code in the app image, switched in the module ledger
 * (in-process), or services of its own, switched by the updater (container).
 */
export type ModuleKind = 'in-process' | 'container';

/** An app a module works with, and the app versions it accepts (`^1.0`). */
export interface AppCompatibility {
  app: string;
  range: string;
}

/**
 * An app (Core Platform Architecture §2.5): which file types it claims and
 * what groups its files into items. One app per library. Music is the only
 * app so far, and always on.
 */
export interface AppManifest {
  id: string;
  /** semver of the app; modules name a range of it (compatibleWith) */
  version: string;
  /** the core API range it was built for (`^1.0`) */
  coreApi: string;
  /** Always on: cannot be turned off (music, while it is the only app). */
  builtIn: boolean;
  /**
   * The file-type handlers it claims (packages/core/src/files: 'audio'). The
   * walk indexes a file only when an app that is on claims its handler.
   */
  fileTypes: readonly string[];
  /** The job that turns its files into items (music: cluster.dir). */
  grouping: { queue: string } | null;
  /** Its jobs (queue names). */
  jobs: readonly string[];
  /** Its own migration folder (packages/db/migrations/apps/<id>/), or null: its tables are in the core chain. */
  migrations: string | null;
  /** The switch its ledger row starts with, when a boot makes one. */
  defaultEnabled: boolean;
}

export interface ModuleManifest {
  id: string;
  /** semver of the module */
  version: string;
  /** Always on (library, collection, reviews): cannot be turned off. */
  builtIn: boolean;
  /** in-process (the module ledger switches it) or container (the updater does). */
  kind: ModuleKind;
  /** the core API range it was built for (`^1.0`) */
  coreApi: string;
  /** The apps it works with. An app that is missing, off or outside the range: the module cannot be on. */
  compatibleWith: readonly AppCompatibility[];
  provides: ReadonlyArray<{ facet: string; version: string; table?: string }>;
  consumes: ReadonlyArray<{ facet: string; range: string }>;
  /** Core fields the module may fill when they are empty (identity_fills). */
  gapFills: ReadonlyArray<{ kind: EntityKind; field: string }>;
  /** Its jobs (queue names). */
  jobs: readonly string[];
  /**
   * Every table the module owns, a table before the ones it references:
   * "Delete its data" (doctor purge-module) empties them in this order, and a
   * schema test checks that every prefixed table has one owner.
   */
  tables: readonly string[];
  /** Table-name prefix the module owns (mc_, player_), if any. */
  prefix: string | null;
  /** Keys of its own settings (installed_modules.settings). */
  settingsKeys: readonly string[];
  /**
   * Its own migration folder (packages/db/migrations/modules/<id>/), applied
   * after the core chain and recorded in the ledger as (<id>, <file>). Null:
   * its tables are in the core chain (they shipped before the ledger had modules).
   */
  migrations: string | null;
  /** The switch its ledger row starts with, when a boot makes one (an existing row keeps its own). */
  defaultEnabled: boolean;
  /**
   * Its values are relayed from another app (mc: what a linked app sent), so
   * a value's source label names the relay, not the outlet. Built-in modules
   * read their sources themselves (false).
   */
  relays: boolean;
  /** Whether it is on, apart from its apps. Default: its switch in the module ledger. */
  enabled(ctx: ModuleContext): boolean;
}

const MODULE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/** A manifest's coreApi must accept this build's CORE_API (the same major, a minor no higher). */
function checkCoreApi(id: string, coreApi: string): void {
  if (!versionMeets(CORE_API, coreApi)) throw new Error(`${id}: built for core API ${coreApi}, this core is ${CORE_API}`);
}

type ModuleDefaults = 'builtIn' | 'kind' | 'coreApi' | 'compatibleWith' | 'gapFills' | 'jobs' | 'tables' | 'prefix' | 'settingsKeys' | 'migrations' | 'defaultEnabled' | 'relays' | 'enabled';

export function defineModule(m: Omit<ModuleManifest, ModuleDefaults> & Partial<Pick<ModuleManifest, ModuleDefaults>>): ModuleManifest {
  if (!MODULE_ID_RE.test(m.id)) throw new Error(`not a module id: ${m.id}`);
  for (const p of m.provides) {
    if (!NAME_RE.test(p.facet)) throw new Error(`${m.id}: provides a facet by name, not id: ${p.facet}`);
    parseVersion(p.version);
  }
  for (const c of m.consumes) {
    if (!NAME_RE.test(c.facet)) throw new Error(`${m.id}: consumes a facet by name, not id: ${c.facet}`);
    parseRange(c.range);
  }
  const coreApi = m.coreApi ?? `^${CORE_API}`;
  checkCoreApi(m.id, coreApi);
  for (const c of m.compatibleWith ?? []) {
    if (!MODULE_ID_RE.test(c.app)) throw new Error(`${m.id}: not an app id: ${c.app}`);
    parseRange(c.range);
  }
  if (m.migrations != null && m.migrations !== `modules/${m.id}`) throw new Error(`${m.id}: its migrations live in modules/${m.id}`);
  const id = m.id;
  return {
    builtIn: false,
    kind: 'in-process',
    compatibleWith: [],
    gapFills: [],
    jobs: [],
    tables: [],
    prefix: null,
    settingsKeys: [],
    migrations: null,
    defaultEnabled: false,
    relays: false,
    enabled: (ctx) => ctx.enabled(id),
    ...m,
    coreApi,
  };
}

export function defineApp(a: Pick<AppManifest, 'id' | 'version' | 'fileTypes'> & Partial<Omit<AppManifest, 'id' | 'version' | 'fileTypes'>>): AppManifest {
  if (!MODULE_ID_RE.test(a.id)) throw new Error(`not an app id: ${a.id}`);
  if (!SEMVER_RE.test(a.version)) throw new Error(`${a.id}: not a version (semver): ${a.version}`);
  const coreApi = a.coreApi ?? `^${CORE_API}`;
  checkCoreApi(a.id, coreApi);
  if (a.migrations != null && a.migrations !== `apps/${a.id}`) throw new Error(`${a.id}: its migrations live in apps/${a.id}`);
  return { builtIn: false, grouping: null, jobs: [], migrations: null, defaultEnabled: false, ...a, coreApi };
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
