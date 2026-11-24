/**
 * The music mount read from the host mount table, and the verdict that tells
 * a dead network share from slow work. Pure: fixtures only, no filesystem.
 */
import { describe, expect, it } from 'vitest';
import { MUSIC_SERVICES } from './music-heal.js';
import { decodeMountPath, MUSIC_BOUND, musicMount, musicVerdict, sharePort, validServer } from './music-probe.js';

/** One real /proc/self/mountinfo line. */
function line(mountPoint: string, fstype: string, source: string, opts: string): string {
  return `36 25 0:52 / ${mountPoint} rw,relatime shared:1 - ${fstype} ${source} ${opts}\n`;
}

const NFS = line('/mnt/music', 'nfs4', '192.0.2.10:/export/music', 'rw,vers=4.2,hard,proto=tcp');
const ROOT = line('/', 'ext4', '/dev/sda1', 'rw');

describe('musicMount', () => {
  it('nfs4 hard', () =>
    expect(musicMount(ROOT + NFS, '/mnt/music')).toEqual({ kind: 'network', fstype: 'nfs4', server: '192.0.2.10', export: '/export/music', hard: true, mountPoint: '/mnt/music' }));
  it('nfs soft', () => expect(musicMount(ROOT + line('/mnt/music', 'nfs', '192.0.2.10:/m', 'rw,soft'), '/mnt/music').hard).toBe(false));
  it('cifs', () =>
    expect(musicMount(ROOT + line('/mnt/music', 'cifs', '//192.0.2.11/music', 'rw,vers=3.0'), '/mnt/music')).toMatchObject({ kind: 'network', server: '192.0.2.11', export: '/music', hard: false }));
  it('local ext4 mount point', () => expect(musicMount(ROOT + line('/mnt/music', 'ext4', '/dev/sdb1', 'rw'), '/mnt/music').kind).toBe('local'));
  it('a plain folder on the root disk', () => expect(musicMount(ROOT, '/srv/music')).toMatchObject({ kind: 'absent', mountPoint: '/' }));
  it('nested prefix', () => expect(musicMount(ROOT + line('/mnt/nas', 'nfs4', '192.0.2.10:/vol', 'rw'), '/mnt/nas/music')).toMatchObject({ kind: 'network', mountPoint: '/mnt/nas' }));
  it('a sibling is not a prefix', () => expect(musicMount(ROOT + line('/mnt/mus', 'nfs4', '192.0.2.10:/v', 'rw'), '/mnt/music').kind).toBe('absent'));
  it('escaped spaces', () => expect(musicMount(ROOT + line('/mnt/my\\040music', 'nfs4', '192.0.2.10:/v', 'rw'), '/mnt/my music').mountPoint).toBe('/mnt/my music'));
  it('bad server text', () => {
    expect(musicMount(ROOT + line('/mnt/music', 'nfs4', '-oProxy=x:/v', 'rw'), '/mnt/music')).toMatchObject({ kind: 'network', server: null });
    expect(validServer('nas.example.com')).toBe('nas.example.com');
    expect(validServer('[2001:db8::1]')).toBe('2001:db8::1');
    expect(validServer('192.0.2.10;rm')).toBeNull();
  });
  it('never returns the mount options', () =>
    expect(JSON.stringify(musicMount(ROOT + line('/mnt/music', 'cifs', '//192.0.2.11/m', 'username=robin,domain=x'), '/mnt/music'))).not.toContain('robin'));
});

describe('helpers', () => {
  it('decodes the mountinfo octal escapes', () => expect(decodeMountPath('/a\\040b\\011c\\012d\\134e')).toBe('/a b\tc\nd\\e'));
  it('gives the share port per fstype', () => {
    expect([sharePort('nfs'), sharePort('nfs4'), sharePort('cifs'), sharePort('smb3'), sharePort('ext4')]).toEqual([2049, 2049, 445, 445, null]);
  });
  it('re-exports the music-bound services', () => expect(MUSIC_BOUND).toEqual([...MUSIC_SERVICES]));
});

describe('verdict', () => {
  const net = musicMount(ROOT + NFS, '/mnt/music');
  const stuck = [{ service: 'worker-files', stuck: true }];
  it.each([
    [net, 'silent', stuck, null, 'music_unreachable'],
    [net, 'answers', stuck, null, 'ok'],
    [net, 'silent', [{ service: 'worker-identify', stuck: true }], null, 'ok'],
    [net, 'unknown', stuck, null, 'ok'],
    [musicMount(ROOT, '/srv/music'), null, [], true, 'music_unmounted'],
    [musicMount(ROOT, '/srv/music'), null, [], false, 'ok'],
  ] as const)('%#', (m, a, p, u, want) => expect(musicVerdict(m, a, [...p], u)).toBe(want));
});
