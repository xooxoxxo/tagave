/**
 * The module ledger (installed_modules, migration 0065): which apps and
 * modules this install has, and whether each is on. One switch per module,
 * install-wide; read per call (each request, each job run), so turning a
 * module on or off needs no restart.
 *
 *   moduleEnabled(sql, id)            is it on? A module with no row is off.
 *   setModuleEnabled(sql, id, on)     turn it on or off; the data stays (rule 2)
 *   moduleSwitches(sql)               every row's switch, for a ModuleContext
 *   moduleSettings / setModuleSettings  the module's own settings (installed_modules.settings)
 *   syncInstalledModules(sql, list)   at boot: a row for every manifest, new ones at their default
 *
 * Turning a module off stops its jobs and hides its UI; deleting its data is
 * the module's own (doctor purge-module, or its Settings › Modules action).
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any>;
type Tx = postgres.TransactionSql<any>;
type Q = Sql | Tx;

export type InstalledModuleKind = 'app' | 'in-process' | 'container';

export interface InstalledModule {
  id: string;
  kind: InstalledModuleKind;
  /** The manifest version the app last recorded; null until a boot did. */
  version: string | null;
  enabled: boolean;
  /** When it was last turned on; null while it is off. */
  enabledAt: Date | null;
  /** The newest migration of its own folder; null while its tables are in the core chain. */
  schemaVersion: string | null;
  settings: Record<string, unknown>;
}

/** What syncInstalledModules needs of a manifest. */
export interface ModuleLedgerEntry {
  id: string;
  kind: InstalledModuleKind;
  version: string;
  /** The switch a row made now starts with. An existing row keeps its own. */
  defaultEnabled: boolean;
}

const jsonObject = (v: unknown): Record<string, unknown> => {
  const o = typeof v === 'string' ? JSON.parse(v) : v;
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
};

/** Whether module `id` is on. A module this install has no row for is off. */
export async function moduleEnabled(sql: Q, id: string): Promise<boolean> {
  const [row] = await sql<Array<{ enabled: boolean }>>`select enabled from installed_modules where id = ${id}`;
  return row?.enabled === true;
}

/**
 * Turn module `id` on or off. On stamps enabled_at, off clears it; turning
 * on a module that is on already keeps its enabled_at. A module with no row
 * yet gets one (its kind and version follow at the next boot's sync).
 */
export async function setModuleEnabled(sql: Q, id: string, enabled: boolean): Promise<void> {
  await sql`
    insert into installed_modules (id, enabled, enabled_at, updated_at)
    values (${id}, ${enabled}::boolean, case when ${enabled}::boolean then now() end, now())
    on conflict (id) do update set
      enabled = excluded.enabled,
      enabled_at = case when not excluded.enabled then null
                        when installed_modules.enabled then installed_modules.enabled_at
                        else now() end,
      updated_at = now()`;
}

/** Every module's switch, by id. */
export async function moduleSwitches(sql: Q): Promise<Record<string, boolean>> {
  const rows = await sql<Array<{ id: string; enabled: boolean }>>`select id, enabled from installed_modules`;
  return Object.fromEntries(rows.map((r) => [r.id, r.enabled]));
}

/** The ids of the apps that are on (music, and later books). */
export async function enabledAppIds(sql: Q): Promise<string[]> {
  const rows = await sql<Array<{ id: string }>>`select id from installed_modules where kind = 'app' and enabled order by id`;
  return rows.map((r) => r.id);
}

export async function listInstalledModules(sql: Q): Promise<InstalledModule[]> {
  const rows = await sql<Array<{ id: string; kind: InstalledModuleKind; version: string | null; enabled: boolean; enabled_at: Date | null; schema_version: string | null; settings: unknown }>>`
    select id, kind, version, enabled, enabled_at, schema_version, settings from installed_modules order by id`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    version: r.version,
    enabled: r.enabled,
    enabledAt: r.enabled_at,
    schemaVersion: r.schema_version,
    settings: jsonObject(r.settings),
  }));
}

/** The module's own settings ({} when it has none, or no row). */
export async function moduleSettings(sql: Q, id: string): Promise<Record<string, unknown>> {
  const [row] = await sql<Array<{ settings: unknown }>>`select settings from installed_modules where id = ${id}`;
  return jsonObject(row?.settings);
}

/**
 * Merge `patch` into the module's own settings: a key set to null goes.
 * Returns the settings as stored. The module must have a row.
 */
export async function setModuleSettings(sql: Q, id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const drop = Object.keys(patch).filter((k) => patch[k] === null);
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null && v !== undefined));
  const rows = await sql<Array<{ settings: unknown }>>`
    update installed_modules
       set settings = (settings || ${JSON.stringify(set)}::jsonb) - ${drop}::text[], updated_at = now()
     where id = ${id}
    returning settings`;
  if (rows.length === 0) throw new Error(`no installed module ${id}`);
  return jsonObject(rows[0]!.settings);
}

/**
 * Make the ledger match the manifests this build carries, at boot: a row for
 * every entry that has none (at its default switch), and each row's kind and
 * version brought up to date. Never changes a switch, never deletes a row (a
 * module a newer build dropped keeps its row and its data until purged).
 * Returns the ids it added.
 */
export async function syncInstalledModules(sql: Q, entries: readonly ModuleLedgerEntry[]): Promise<string[]> {
  if (entries.length === 0) return [];
  const rows = await sql<Array<{ id: string; added: boolean }>>`
    insert into installed_modules (id, kind, version, enabled, enabled_at)
    select e.id, e.kind, e.version, e.on_, case when e.on_ then now() end
      from unnest(${entries.map((e) => e.id)}::text[], ${entries.map((e) => e.kind)}::text[],
                  ${entries.map((e) => e.version)}::text[], ${entries.map((e) => e.defaultEnabled)}::boolean[])
           as e(id, kind, version, on_)
    on conflict (id) do update set kind = excluded.kind, version = excluded.version, updated_at = now()
      where installed_modules.kind is distinct from excluded.kind or installed_modules.version is distinct from excluded.version
    returning id, (xmax = 0) as added`;
  return rows.filter((r) => r.added).map((r) => r.id).sort();
}
