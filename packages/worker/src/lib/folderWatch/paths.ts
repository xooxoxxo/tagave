/**
 * Where the file worker finds a music root. The music folder is bound at
 * /mnt/music, and its parent folder at /mnt/.host so a share mounted there
 * later propagates in. TAGAVE_MUSIC_NAME is the music folder's name inside
 * that parent. Pure string work: nothing here touches the disk.
 */

export const MUSIC_MOUNT = '/mnt/music';
export const PARENT_MOUNT = '/mnt/.host';

const NAME = /^[A-Za-z0-9._ -]{1,255}$/;

/** The music folder's name in the parent bind, or null when it is unset or not a plain name. */
export function musicName(env: NodeJS.ProcessEnv): string | null {
  const name = env.TAGAVE_MUSIC_NAME;
  if (name === undefined || !NAME.test(name) || name === '.' || name === '..') return null;
  return name;
}

/** With a name, `/mnt/music` and anything under it, seen through the parent bind; otherwise the path as given. */
export function realRootPath(rootPath: string, name: string | null): string {
  if (name === null) return rootPath;
  if (rootPath === MUSIC_MOUNT) return `${PARENT_MOUNT}/${name}`;
  if (rootPath.startsWith(`${MUSIC_MOUNT}/`)) return `${PARENT_MOUNT}/${name}${rootPath.slice(MUSIC_MOUNT.length)}`;
  return rootPath;
}
