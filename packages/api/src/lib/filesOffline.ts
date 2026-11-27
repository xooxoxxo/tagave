/**
 * The "files offline" fields on album responses (db › filesOffline.ts): the
 * album list, album page, search and the artist page spread `fieldsOf(id)`
 * into each album. With every enabled music folder online (the usual case)
 * it is `{}`, so the keys are absent and only notOnlineRoots ran; otherwise
 * every album carries `filesOffline` ('all' | 'some' | null) and
 * `offlineSince`.
 */
import { albumsOffline, notOnlineRoots } from '@tagave/db';
import { getSql } from '../db.js';

export interface FilesOfflineFields {
  filesOffline?: 'all' | 'some' | null;
  offlineSince?: string | null;
}

export async function filesOfflineFields(albumIds: string[]): Promise<(albumId: string | null) => FilesOfflineFields> {
  if (albumIds.length === 0) return () => ({});
  const sql = getSql();
  const roots = await notOnlineRoots(sql);
  if (roots.size === 0) return () => ({});
  const offline = await albumsOffline(sql, albumIds, roots);
  return (albumId) => {
    const hit = albumId ? offline.get(albumId) : undefined;
    return { filesOffline: hit?.filesOffline ?? null, offlineSince: hit?.since ?? null };
  };
}
