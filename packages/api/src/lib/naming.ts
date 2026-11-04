/**
 * Naming rules and the drop pool as libraries.settings keeps them (naming,
 * dropPool; vault "tagave - Naming Rules and Drop Pool"), and the album
 * reads the API names files from. The API never touches a music file: it
 * reads the database and asks the file worker.
 */
import {
  DEFAULT_NAMING_RULES, albumPaths, currentFieldsFrom, detectNaming, namingValuesOf, rulesProblems,
  type NamingRules, type NamingSample,
} from '@tagave/core';
import { namingRulesSchema } from '@tagave/shared';
import type { getSql } from '../db.js';

type Sql = ReturnType<typeof getSql>;

export interface DropPoolSetting {
  enabled: boolean;
  scanRootId: string | null;
  dirPath: string | null;
}

export async function settingsOf(sql: Sql, libraryId: string): Promise<Record<string, unknown>> {
  const [r] = await sql<Array<{ settings: unknown }>>`select settings from libraries where id = ${libraryId}`;
  const s = typeof r?.settings === 'string' ? JSON.parse(r.settings) : r?.settings;
  return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
}

/** One key of libraries.settings, the others kept. */
export async function saveSetting(sql: Sql, libraryId: string, key: string, value: unknown): Promise<void> {
  await sql`
    update libraries
       set settings = (case when jsonb_typeof(settings) = 'object' then settings else '{}'::jsonb end) || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb)
     where id = ${libraryId}`;
}

/** The saved rules (saved: true), or the default ones when none are saved or they no longer validate. */
export async function namingSettings(sql: Sql, libraryId: string): Promise<{ rules: NamingRules; saved: boolean }> {
  const parsed = namingRulesSchema.safeParse((await settingsOf(sql, libraryId))['naming']);
  if (parsed.success && Object.keys(rulesProblems(parsed.data)).length === 0) return { rules: parsed.data, saved: true };
  return { rules: DEFAULT_NAMING_RULES, saved: false };
}

export function dropPoolSetting(settings: Record<string, unknown>): DropPoolSetting {
  const p = (settings['dropPool'] ?? {}) as Partial<DropPoolSetting>;
  return {
    enabled: p.enabled === true,
    scanRootId: typeof p.scanRootId === 'string' ? p.scanRootId : null,
    dirPath: typeof p.dirPath === 'string' && p.dirPath ? p.dirPath : null,
  };
}

export interface AlbumFiles {
  albumId: string;
  title: string | null;
  artist: string | null;
  soundtrack: boolean;
  files: Array<{ fileId: string; rootId: string; relPath: string; tags: unknown }>;
}

/**
 * Albums with their present, kept files (a cue image's tracks share one file:
 * left out), oldest first. `albumIds` narrows it; `limit` caps the albums.
 */
export async function albumsWithFiles(sql: Sql, libraryId: string, opts: { albumIds?: string[]; limit?: number; sample?: boolean } = {}): Promise<AlbumFiles[]> {
  const rows = await sql<Array<{
    albumId: string; title: string | null; artist: string | null; types: string[] | null;
    fileId: string; rootId: string; relPath: string; tags: unknown;
  }>>`
    with picked as (
      select la.id, la.title_guess, la.artist_guess, la.release_group_id
        from local_albums la
       where la.library_id = ${libraryId}
         and (${opts.albumIds ?? null}::uuid[] is null or la.id = any(${opts.albumIds ?? null}::uuid[]))
         and exists (select 1 from local_tracks lt join files f on f.id = lt.audio_file_id
                      where lt.local_album_id = la.id and f.status = 'present')
       order by ${opts.sample ? sql`md5(la.id::text)` : sql`la.created_at, la.id`}
       limit ${opts.limit ?? 1_000_000}
    )
    select p.id::text as "albumId", p.title_guess as title, p.artist_guess as artist, rg.secondary_types as types,
           f.id::text as "fileId", f.scan_root_id::text as "rootId", f.rel_path as "relPath",
           jsonb_build_object('common', f.tags_raw->'common') as tags
      from picked p
      join local_tracks lt on lt.local_album_id = p.id and lt.origin <> 'cue'
      join files f on f.id = lt.audio_file_id and f.status = 'present'
      left join release_groups rg on rg.id = p.release_group_id
     where not exists (select 1 from file_deletions fd where fd.file_id = f.id)
     order by p.id, f.rel_path`;
  const out = new Map<string, AlbumFiles>();
  for (const r of rows) {
    let a = out.get(r.albumId);
    if (!a) {
      a = { albumId: r.albumId, title: r.title, artist: r.artist, soundtrack: (r.types ?? []).some((t) => t.toLowerCase() === 'soundtrack'), files: [] };
      out.set(r.albumId, a);
    }
    if (!a.files.some((f) => f.fileId === r.fileId)) a.files.push({ fileId: r.fileId, rootId: r.rootId, relPath: r.relPath, tags: r.tags });
  }
  return [...out.values()];
}

/** Where the rules put an album's files (from the tags they carry now). */
export function albumRulePaths(rules: NamingRules, a: AlbumFiles) {
  return albumPaths(rules, a.files.map((f) => ({ relPath: f.relPath, fields: currentFieldsFrom(f.tags) })), { soundtrack: a.soundtrack });
}

/** The library's own pattern, from a sample of its albums (each album's first file). */
export async function detectLibraryNaming(sql: Sql, libraryId: string) {
  const albums = await albumsWithFiles(sql, libraryId, { limit: 300, sample: true });
  const samples: NamingSample[] = albums.flatMap((a) => {
    const f = a.files[0];
    if (!f) return [];
    const fields = currentFieldsFrom(f.tags);
    if (!fields.album || !(fields.albumartist || fields.artist)) return [];
    const discs = new Set(a.files.map((x) => currentFieldsFrom(x.tags).discnumber).filter(Boolean)).size;
    const ext = f.relPath.includes('.') ? f.relPath.slice(f.relPath.lastIndexOf('.') + 1) : '';
    return [{ path: f.relPath, values: namingValuesOf(fields, ext, { discs, soundtrack: a.soundtrack }) }];
  });
  return detectNaming(samples);
}

/** Three songs of the library, where they are and where the rules put them. */
export async function namingExamples(sql: Sql, libraryId: string, rules: NamingRules): Promise<Array<{ albumId: string; from: string; to: string }>> {
  const albums = await albumsWithFiles(sql, libraryId, { limit: 40, sample: true });
  const tagged = albums.filter((a) => {
    const f = a.files[0];
    if (!f) return false;
    const fields = currentFieldsFrom(f.tags);
    return !!fields.album && !!fields.title;
  });
  // a Leave alone folder never moves: not an example
  return tagged.map((a) => ({ a, planned: albumRulePaths(rules, a) })).filter((x) => !x.planned.leftAlone).slice(0, 3).map(({ a, planned }) => {
    const first = planned.files[0]!;
    return { albumId: a.albumId, from: first.relPath, to: first.toPath };
  });
}
