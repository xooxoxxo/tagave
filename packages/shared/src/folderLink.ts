/**
 * "Open folder" links on the album page. The server sees the music under the
 * scan root's path (/music inside a container, say); the owner's computer
 * sees the same folder somewhere else (smb://nas/music/, file:///Volumes/music/).
 * The owner sets that base once per scan root; an album folder (stored
 * relative to its root) is then the base plus the relative path, each
 * segment URL-encoded ("#" would otherwise end the path, "%" start an escape).
 *
 * Browsers: an smb:// or afp:// link hands the folder to Finder or Explorer on
 * most systems; file:// links from a web page are usually blocked by the
 * browser, so the album page offers "Copy path" next to the link.
 */

/** Schemes an open-folder base may use. Never javascript:, data: or the like. */
export const FOLDER_LINK_SCHEMES = ['smb', 'afp', 'nfs', 'file', 'http', 'https', 'ftp', 'sftp'] as const;

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

/** Why a base is not usable, or null when it is. Empty means "no link" and is fine. */
export function folderLinkBaseProblem(base: string): string | null {
  const trimmed = base.trim();
  if (!trimmed) return null;
  const m = trimmed.match(SCHEME);
  if (!m) return 'Start with a scheme, such as smb://nas/music/ or file:///Volumes/music/';
  if (!(FOLDER_LINK_SCHEMES as readonly string[]).includes(m[1]!.toLowerCase())) {
    return `Use one of: ${FOLDER_LINK_SCHEMES.map((s) => `${s}://`).join(', ')}`;
  }
  if (/[\u0000-\u001f]/.test(trimmed)) return 'The link has a control character in it';
  return null;
}

/** The base as stored: trimmed and ending in a slash, or null when empty. */
export function normalizeFolderLinkBase(base: string | null | undefined): string | null {
  const trimmed = (base ?? '').trim();
  if (!trimmed) return null;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/**
 * The link for an album folder: `base` + `relDir` with every segment
 * URL-encoded. `relDir` is relative to the scan root (as dir_paths are); an
 * absolute path that starts with `rootPath` has that prefix taken off first.
 * Null when there is no usable base.
 */
export function folderLinkFor(base: string | null | undefined, relDir: string, rootPath?: string | null): string | null {
  const b = normalizeFolderLinkBase(base);
  if (!b || folderLinkBaseProblem(b)) return null;
  let rel = relDir;
  const root = (rootPath ?? '').replace(/\/+$/, '');
  if (root && (rel === root || rel.startsWith(`${root}/`))) rel = rel.slice(root.length);
  const encoded = rel.split('/').filter((s) => s !== '' && s !== '.').map(encodeURIComponent).join('/');
  return encoded ? `${b}${encoded}/` : b;
}
