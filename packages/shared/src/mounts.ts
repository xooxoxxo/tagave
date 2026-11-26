/**
 * Same as packages/updater/src/music-probe.ts (the updater image ships no packages): change both; music-probe.test.ts checks they agree.
 *
 * Reads the mount that holds a folder from /proc/self/mountinfo text, which
 * the kernel answers without asking the remote filesystem. Pure: no node
 * imports, no I/O. Only fstype, server, export and `hard` leave
 * `musicMount`; the mount's super options never do (CIFS options can carry
 * `username=` and `domain=`).
 */

export type MountKind = 'network' | 'local' | 'absent';

export interface MusicMount {
  kind: MountKind;
  fstype: string | null;
  server: string | null;
  export: string | null;
  hard: boolean;
  mountPoint: string | null;
}

const NFS_TYPES = new Set(['nfs', 'nfs4']);
const CIFS_TYPES = new Set(['cifs', 'smb3']);

/** Decodes the octal escapes mountinfo uses in paths: space, tab, newline and backslash. */
export function decodeMountPath(text: string): string {
  return text.replace(/\\(040|011|012|134)/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_BRACKETED = /^\[([0-9A-Fa-f:.]+)\]$/;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63})*$/;

/** A server name safe to pass on: an IPv4 address, a bracketed IPv6 address (returned bare) or a hostname. */
export function validServer(text: string): string | null {
  if (IPV4.test(text)) return text;
  const v6 = IPV6_BRACKETED.exec(text)?.[1];
  if (v6 !== undefined) return v6.includes(':') ? v6 : null;
  if (text.length <= 253 && HOSTNAME.test(text)) return text;
  return null;
}

/** The port the share's server listens on, by fstype. */
export function sharePort(fstype: string): number | null {
  if (NFS_TYPES.has(fstype)) return 2049;
  if (CIFS_TYPES.has(fstype)) return 445;
  return null;
}

interface MountLine {
  mountPoint: string;
  fstype: string;
  source: string;
  options: string[];
}

function parseLine(text: string): MountLine | null {
  const sep = text.indexOf(' - ');
  if (sep < 0) return null;
  const mountPoint = text.slice(0, sep).split(' ')[4];
  const [fstype, source, options = ''] = text.slice(sep + 3).split(' ');
  if (!mountPoint || !fstype || !source) return null;
  return { mountPoint: decodeMountPath(mountPoint), fstype, source, options: options.split(',') };
}

/** Whether `mountPoint` covers `dir`: equal, or a prefix on a `/` boundary. */
function covers(mountPoint: string, dir: string): boolean {
  if (mountPoint === '/') return dir.startsWith('/');
  return dir === mountPoint || dir.startsWith(`${mountPoint}/`);
}

/** Server and export from an NFS `host:/export` or a CIFS `//host/share` source. */
function sourceParts(fstype: string, source: string): { server: string | null; export: string | null } {
  const match = NFS_TYPES.has(fstype) ? /^(\[[^\]]*\]|[^:]+):(\/.*)$/.exec(source) : /^\/\/(\[[^\]]*\]|[^/]+)(\/.*)$/.exec(source);
  const [, host, path] = match ?? [];
  const server = host ? validServer(host) : null;
  if (!server || !path) return { server: null, export: null };
  return { server, export: decodeMountPath(path) };
}

/** The mount that holds `dir`, read from mountinfo text: the longest mount point that covers it. */
export function musicMount(mountinfo: string, dir: string): MusicMount {
  const target = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
  let best: MountLine | null = null;
  for (const text of mountinfo.split('\n')) {
    const mount = parseLine(text);
    // `>=`: a later mount on the same point sits on top of the earlier one.
    if (mount && covers(mount.mountPoint, target) && (!best || mount.mountPoint.length >= best.mountPoint.length)) best = mount;
  }
  if (!best) return { kind: 'absent', fstype: null, server: null, export: null, hard: false, mountPoint: null };
  const { fstype, mountPoint, options } = best;
  if (sharePort(fstype) !== null) {
    const hard = NFS_TYPES.has(fstype) ? !options.includes('soft') : options.includes('hard');
    return { kind: 'network', fstype, ...sourceParts(fstype, best.source), hard, mountPoint };
  }
  return { kind: mountPoint === target ? 'local' : 'absent', fstype, server: null, export: null, hard: false, mountPoint };
}

/** Every mount point in mountinfo text (field 5 of each line), decoded. */
export function mountPoints(mountinfo: string): Set<string> {
  const points = new Set<string>();
  for (const text of mountinfo.split('\n')) {
    const mountPoint = text.split(' ')[4];
    if (mountPoint) points.add(decodeMountPath(mountPoint));
  }
  return points;
}
