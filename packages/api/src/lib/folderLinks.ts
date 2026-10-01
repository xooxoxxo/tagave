/**
 * Album folders with their "Open folder" links (see @liner/shared folderLink).
 * The base per scan root lives in the library settings as `folderLinks`
 * ({ [scanRootId]: 'smb://nas/music/' }); a folder is linked only when its
 * root has one.
 */
import { sql } from 'drizzle-orm';
import { folderLinkFor } from '@liner/shared';

export interface AlbumFolderView {
  /** relative to the scan root, as dir_paths are */
  path: string;
  scanRootId: string | null;
  /** the folder on the owner's computer, or null without a base for its root */
  link: string | null;
}

/** Library settings as a plain object, whether the driver gave JSON text or an object. */
export function settingsObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

/** The open-folder bases, by scan root id; anything malformed is dropped. */
export function folderLinksOf(rawSettings: unknown): Record<string, string> {
  const links = settingsObject(rawSettings)['folderLinks'];
  if (!links || typeof links !== 'object' || Array.isArray(links)) return {};
  return Object.fromEntries(Object.entries(links as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
}

/**
 * Each of the album's folders with the scan root its files are under and
 * its link. A folder no file reports (an edge after a move) takes the root
 * of the album's only root, if it has just one.
 */
export function albumFoldersView(
  dirPaths: readonly string[],
  fileDirs: ReadonlyArray<{ dir: string; scanRootId: string }>,
  links: Readonly<Record<string, string>>,
): AlbumFolderView[] {
  const rootOf = new Map(fileDirs.map((f) => [f.dir, f.scanRootId]));
  const roots = [...new Set(fileDirs.map((f) => f.scanRootId))];
  return dirPaths.map((path) => {
    const scanRootId = rootOf.get(path) ?? (roots.length === 1 ? roots[0]! : null);
    return { path, scanRootId, link: scanRootId ? folderLinkFor(links[scanRootId], path) : null };
  });
}

/** The folders of one album, read from its tracks' files. */
export async function albumFolders(db: any, albumId: string, dirPaths: readonly string[], rawSettings: unknown): Promise<AlbumFolderView[]> {
  if (dirPaths.length === 0) return [];
  const rows = (await db.execute(sql`
    select distinct af.scan_root_id::text as scan_root_id,
           case when position('/' in af.rel_path) > 0 then regexp_replace(af.rel_path, '/[^/]*$', '') else '' end as dir
      from local_tracks lt join audio_files af on af.id = lt.audio_file_id
     where lt.local_album_id = ${albumId}`)) as unknown as Array<{ scan_root_id: string; dir: string }>;
  return albumFoldersView(dirPaths, rows.map((r) => ({ dir: r.dir, scanRootId: r.scan_root_id })), folderLinksOf(rawSettings));
}
