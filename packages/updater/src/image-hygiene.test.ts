import { describe, expect, it } from 'vitest';
import {
  compareReleases,
  parseImageList,
  playerGroups,
  removeOldImages,
  selectOldImages,
  splitImageRef,
  tagaveGroups,
  type LocalImage,
} from './image-hygiene.js';
import type { CommandResult, Runner } from './runner.js';

const REG = 'ghcr.io/xooxoxxo';
const img = (repository: string, tag: string, id = `sha256:${repository}-${tag}`): LocalImage => ({ repository, tag, id });
const tagave = (version: string) => ['tagave-app', 'tagave-worker', 'tagave-updater'].map((n) => img(`${REG}/${n}`, version));
const refs = (images: LocalImage[]) => images.map((i) => `${i.repository}:${i.tag}`).sort();

describe('release order', () => {
  it('compares release numbers numerically, a pre-release before its release', () => {
    expect(compareReleases('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareReleases('0.7.2', '0.7.10')).toBeLessThan(0);
    expect(compareReleases('0.9.0-rc.1', '0.9.0')).toBeLessThan(0);
    expect(compareReleases('0.8.0', '0.8.0')).toBe(0);
    expect(compareReleases('latest', '0.8.0')).toBeNull();
  });

  it('splits image references, dropping Docker Hub prefixes; a digest reference is not split', () => {
    expect(splitImageRef('deluan/navidrome:0.64.0')).toEqual({ repository: 'deluan/navidrome', tag: '0.64.0' });
    expect(splitImageRef('docker.io/deluan/navidrome:0.64.0')).toEqual({ repository: 'deluan/navidrome', tag: '0.64.0' });
    expect(splitImageRef('registry.local:5000/tagave-app:0.8.0')).toEqual({ repository: 'registry.local:5000/tagave-app', tag: '0.8.0' });
    expect(splitImageRef('registry.local:5000/tagave-app')).toBeNull();
    expect(splitImageRef('deluan/navidrome@sha256:abc')).toBeNull();
  });
});

describe('which images go', () => {
  // What production had on 2026-10-15, plus images that are not tagave's.
  const local = [
    ...tagave('0.7.0'),
    ...tagave('0.7.2'),
    ...tagave('0.7.5'),
    ...tagave('0.8.0'),
    img(`${REG}/tagave-app`, 'latest'),
    img(`${REG}/tagave-app`, 'edge'),
    img('postgres', '16'),
    img(`${REG}/tagave-app-fork`, '0.1.0'),
    img('ghcr.io/someone/tagave-app', '0.1.0'),
    img(`${REG}/tagave-web`, '0.1.0'),
    img('deluan/navidrome', '0.60.0'),
  ];

  it('keeps the current and the previous version, removes the older tagave images and nothing else', () => {
    const groups = tagaveGroups(REG, '0.7.5', '0.8.0', local);
    const sel = selectOldImages(local, groups, new Set());
    expect(refs(sel.remove)).toEqual(refs([...tagave('0.7.0'), ...tagave('0.7.2')]));
    expect(sel.inUse).toEqual([]);
  });

  it('keeps an old image a container uses (stopped too), by id or by name', () => {
    const groups = tagaveGroups(REG, '0.7.5', '0.8.0', local);
    const sel = selectOldImages(local, groups, new Set([`sha256:${REG}/tagave-app-0.7.0`]), new Set([`${REG}/tagave-worker:0.7.2`]));
    expect(refs(sel.inUse)).toEqual([`${REG}/tagave-app:0.7.0`, `${REG}/tagave-worker:0.7.2`]);
    expect(sel.remove).toHaveLength(4);
  });

  it('never removes images newer than the previous version (a target pulled for an update that failed)', () => {
    const images = [...tagave('0.7.0'), ...tagave('0.8.0'), ...tagave('0.9.0')];
    const sel = selectOldImages(images, tagaveGroups(REG, '0.7.0', '0.8.0', images), new Set());
    expect(sel.remove).toEqual([]);
  });

  it('takes the newest older local release as the previous one when .env said latest', () => {
    const groups = tagaveGroups(REG, 'latest', '0.8.0', local);
    expect(groups[0]!.keep).toEqual(['0.8.0', '0.7.5']);
    expect(refs(selectOldImages(local, groups, new Set()).remove)).toEqual(refs([...tagave('0.7.0'), ...tagave('0.7.2')]));
  });

  it('uses the registry from .env, matched exactly', () => {
    const images = [...tagave('0.7.0'), img('registry.local:5000/tagave-app', '0.7.0'), img('registry.local:5000/tagave-app', '0.8.0')];
    const sel = selectOldImages(images, tagaveGroups('registry.local:5000', '0.8.0', '0.9.0', images), new Set());
    expect(refs(sel.remove)).toEqual(['registry.local:5000/tagave-app:0.7.0']);
  });

  it('removes nothing for a group without a release to measure by', () => {
    const groups = tagaveGroups(REG, 'latest', '0.7.0', tagave('0.7.0'));
    expect(groups[0]!.keep).toEqual(['0.7.0']);
    expect(selectOldImages(local, [{ repository: `${REG}/tagave-app`, keep: ['edge'] }], new Set()).remove).toEqual([]);
  });

  it("removes only the player's exact previous image, and only when the update moved it", () => {
    const images = [img('deluan/navidrome', '0.62.0'), img('deluan/navidrome', '0.63.0'), img('deluan/navidrome', '0.64.0'), img('deluan/navidrome', 'latest')];
    expect(playerGroups('deluan/navidrome:0.64.0', 'deluan/navidrome:0.64.0')).toEqual([]);
    expect(playerGroups('deluan/navidrome:0.64.0', 'docker.io/deluan/navidrome:0.64.0')).toEqual([]);
    expect(playerGroups(null, 'deluan/navidrome:0.64.0')).toEqual([]);
    const groups = playerGroups('deluan/navidrome:0.63.0', 'docker.io/deluan/navidrome:0.64.0');
    // 0.62.0 may be someone else's Navidrome: it stays
    expect(refs(selectOldImages(images, groups, new Set()).remove)).toEqual(['deluan/navidrome:0.63.0']);
    expect(selectOldImages(images, groups, new Set(), new Set(['deluan/navidrome:0.63.0'])).inUse).toHaveLength(1);
    // an override to another repository: the old one's exact tag only
    const moved = playerGroups('deluan/navidrome:0.63.0', 'registry.local/navidrome:0.64.0');
    expect(refs(selectOldImages(images, moved, new Set()).remove)).toEqual(['deluan/navidrome:0.63.0']);
  });

  it('orders pre-releases by number and never removes one', () => {
    expect(compareReleases('0.9.0-rc.10', '0.9.0-rc.9')).toBeGreaterThan(0);
    expect(compareReleases('0.9.0-rc.9', '0.9.0-rc.10')).toBeLessThan(0);
    expect(compareReleases('0.9.0-alpha', '0.9.0-rc.1')).toBeLessThan(0);
    const images = [...tagave('0.7.0'), ...tagave('0.8.0'), ...tagave('0.8.0-rc.9'), ...tagave('0.8.0-rc.10'), ...tagave('0.9.0'), ...tagave('1.0.0')];
    const sel = selectOldImages(images, tagaveGroups(REG, '0.9.0', '1.0.0', images), new Set());
    expect(refs(sel.remove)).toEqual(refs([...tagave('0.7.0'), ...tagave('0.8.0')]));
    // .env said latest: the newest older release stands in, rc.10 above rc.9
    const groups = tagaveGroups(REG, 'latest', '0.8.0', [...tagave('0.8.0-rc.9'), ...tagave('0.8.0-rc.10')]);
    expect(groups[0]!.keep).toEqual(['0.8.0', '0.8.0-rc.10']);
  });

  it('parses docker image ls, skipping untagged images', () => {
    expect(parseImageList(`${REG}/tagave-app\t0.8.0\tsha256:a\n<none>\t<none>\tsha256:b\npostgres\t16\tsha256:c\n`)).toEqual([
      img(`${REG}/tagave-app`, '0.8.0', 'sha256:a'),
      img('postgres', '16', 'sha256:c'),
    ]);
  });
});

/**
 * A Docker with images and containers: `image rm` refuses an image a
 * container uses (as the real one does without -f).
 */
class FakeDocker {
  images: Array<LocalImage & { size: number }> = [];
  containers: Array<{ id: string; image: string }> = [];
  calls: string[] = [];

  pull(ref: string): void {
    const s = splitImageRef(ref)!;
    if (!this.images.some((i) => i.repository === s.repository && i.tag === s.tag)) {
      this.images.push({ ...img(s.repository, s.tag), size: 500 * 1024 ** 2 });
    }
  }

  /** Containers of `services` recreated on `version`. */
  run(version: string, names = ['tagave-app', 'tagave-worker', 'tagave-updater']): void {
    for (const n of names) {
      this.containers = this.containers.filter((c) => !c.id.startsWith(`${n}-`));
      this.pull(`${REG}/${n}:${version}`);
      this.containers.push({ id: `${n}-${version}`, image: `${REG}/${n}:${version}` });
    }
  }

  private idOf(ref: string): string | undefined {
    if (ref.startsWith('sha256:')) return ref;
    const s = splitImageRef(ref)!;
    return this.images.find((i) => i.repository === s.repository && i.tag === s.tag)?.id;
  }

  runner: Runner = async (args) => {
    const a = args.join(' ');
    this.calls.push(a);
    const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'image' && args[1] === 'ls') return ok(this.images.map((i) => `${i.repository}\t${i.tag}\t${i.id}`).join('\n'));
    if (args[0] === 'ps') return ok(this.containers.map((c) => `${c.id}\t${c.image}`).join('\n'));
    if (args[0] === 'inspect') return ok(args.slice(3).map((id) => this.idOf(this.containers.find((c) => c.id === id)!.image)).join('\n'));
    if (args[0] === 'image' && args[1] === 'inspect') return ok(String(this.images.find((i) => i.id === this.idOf(args.at(-1)!))?.size ?? ''));
    if (args[0] === 'image' && args[1] === 'rm') {
      if (args.includes('-f') || args.includes('--force')) throw new Error('never -f');
      const id = this.idOf(args[2]!);
      if (!id) return { code: 1, stdout: '', stderr: `Error: No such image: ${args[2]}` };
      if (this.containers.some((c) => this.idOf(c.image) === id)) return { code: 1, stdout: '', stderr: 'Error response from daemon: conflict: unable to remove repository reference (must force) - container is using its referenced image' };
      this.images = this.images.filter((i) => i.id !== id);
      return ok(`Untagged: ${args[2]}`);
    }
    return { code: 1, stdout: '', stderr: `unexpected: docker ${a}` };
  };
}

describe('removeOldImages against a Docker', () => {
  it('after 5 consecutive updates only the current and the previous tagave images remain', async () => {
    const docker = new FakeDocker();
    docker.pull('postgres:16');
    docker.pull('deluan/navidrome:0.58.0');
    docker.pull(`${REG}/tagave-app:edge`);
    docker.run('0.7.0');
    const versions = ['0.7.0', '0.7.2', '0.7.5', '0.8.0', '0.8.1', '0.9.0'];
    for (let i = 1; i < versions.length; i += 1) {
      const [from, target] = [versions[i - 1]!, versions[i]!];
      // The update recreates app and workers on the target; the updater
      // container still runs the old version until it replaces itself.
      docker.run(target, ['tagave-app', 'tagave-worker']);
      docker.pull(`${REG}/tagave-updater:${target}`);
      const res = await removeOldImages(docker.runner, (images) => tagaveGroups(REG, from, target, images));
      expect(res.failed).toEqual([]);
      docker.run(target, ['tagave-updater']);
    }
    expect(refs(docker.images)).toEqual([
      'deluan/navidrome:0.58.0',
      `${REG}/tagave-app:0.8.1`,
      `${REG}/tagave-app:0.9.0`,
      `${REG}/tagave-app:edge`,
      `${REG}/tagave-updater:0.8.1`,
      `${REG}/tagave-updater:0.9.0`,
      `${REG}/tagave-worker:0.8.1`,
      `${REG}/tagave-worker:0.9.0`,
      'postgres:16',
    ].sort());
    expect(docker.calls.some((c) => c.includes('prune'))).toBe(false);
  });

  it('reports what it removed and its size; an image Docker refuses is a failure in the result', async () => {
    const docker = new FakeDocker();
    for (const v of ['0.7.0', '0.7.2', '0.7.5', '0.8.0']) for (const i of tagave(v)) docker.pull(`${i.repository}:${i.tag}`);
    docker.containers.push({ id: 'old-updater', image: `${REG}/tagave-updater:0.7.0` });
    // made before its tag moved: docker ps names the image by id
    docker.containers.push({ id: 'by-id', image: `sha256:${REG}/tagave-worker-0.7.0` });
    const res = await removeOldImages(docker.runner, (images) => tagaveGroups(REG, '0.7.5', '0.8.0', images));
    expect(res.inUse.sort()).toEqual([`${REG}/tagave-updater:0.7.0`, `${REG}/tagave-worker:0.7.0`]);
    expect(res.removed).toHaveLength(4);
    expect(res.bytes).toBe(4 * 500 * 1024 ** 2);
    expect(res.failed).toEqual([]);
    expect(docker.calls.filter((c) => c.startsWith('image rm')).every((c) => !c.includes('-f'))).toBe(true);
  });

  it('lists nothing more when there is nothing to remove', async () => {
    const docker = new FakeDocker();
    docker.run('0.8.0');
    const res = await removeOldImages(docker.runner, (images) => tagaveGroups(REG, '0.7.5', '0.8.0', images));
    expect(res).toEqual({ removed: [], bytes: 0, inUse: [], failed: [] });
    expect(docker.calls).toEqual(['image ls --no-trunc --format {{.Repository}}\t{{.Tag}}\t{{.ID}}']);
  });

  it('throws when Docker cannot list the images', async () => {
    const failing: Runner = async () => ({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' });
    await expect(removeOldImages(failing, () => [])).rejects.toThrow(/Cannot connect/);
  });
});
