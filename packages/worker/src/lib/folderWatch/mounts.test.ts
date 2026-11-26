/**
 * The mount table as the file worker sees it: the music share is bound
 * under the parent folder (/mnt/.host) and propagates into the container.
 */
import { describe, expect, it } from 'vitest';
import { mountPoints, musicMount } from '@tagave/shared/mounts';

/** One real /proc/self/mountinfo line. */
function line(mountPoint: string, fstype: string, source: string, opts: string): string {
  return `36 25 0:52 / ${mountPoint} rw,relatime shared:1 - ${fstype} ${source} ${opts}\n`;
}

const C = line('/', 'overlay', 'overlay', 'rw') + line('/mnt/.host', 'ext4', '/dev/sda1', 'rw') + line('/mnt/.host/music', 'nfs4', '192.0.2.10:/export/music', 'rw,hard');

describe('mounts in the file worker', () => {
  it('finds the propagated share under the parent bind', () => {
    expect(musicMount(C, '/mnt/.host/music/Jazz')).toMatchObject({ kind: 'network', server: '192.0.2.10', mountPoint: '/mnt/.host/music' });
    expect(mountPoints(C).has('/mnt/.host/music')).toBe(true);
  });
  it('lists every mount point, decoded', () => {
    expect(mountPoints(C)).toEqual(new Set(['/', '/mnt/.host', '/mnt/.host/music']));
    expect(mountPoints(line('/mnt/my\\040music', 'nfs4', '192.0.2.10:/v', 'rw')).has('/mnt/my music')).toBe(true);
    expect(mountPoints('').size).toBe(0);
  });
});
