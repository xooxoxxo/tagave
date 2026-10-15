import { describe, expect, it } from 'vitest';
import {
  BACKUPS_PROBE_JS,
  GB,
  MB,
  checkSpace,
  dockerArch,
  formatBytes,
  imageDownloadBytes,
  parseImageRef,
  planSpace,
  registryClient,
  requiredBytes,
  backupsOnHostFolder,
  filesystemRelation,
  spaceShortMessage,
  type Fetch,
  type FsReading,
  type Layer,
  type SpaceProbeDeps,
} from './preflight-space.js';
import type { CommandResult } from './runner.js';

const docker = (free: number, total: number | null = 100 * GB): FsReading => ({ where: '/var/lib/docker', freeBytes: free, totalBytes: total });

describe('the arithmetic', () => {
  it('adds the 20 % margin, then the headroom', () => {
    expect(requiredBytes(10 * GB, 3 * GB)).toBe(15 * GB);
    expect(requiredBytes(0, 3 * GB)).toBe(3 * GB);
  });

  it('counts unpacked images and two dumps on one filesystem when the backups share it', () => {
    const [c, ...rest] = planSpace(docker(20 * GB), { where: '/backups', freeBytes: 20 * GB, totalBytes: 100 * GB }, { imageBytes: 1 * GB, backupBytes: 1 * GB }, 3 * GB);
    expect(rest).toEqual([]);
    // (2.5 + 2) × 1.2 + 3
    expect(c!.requiredBytes).toBe(Math.ceil(4.5 * GB * 1.2) + 3 * GB);
    expect(c!.parts.map((p) => p.what)).toEqual(['the new images, unpacked', '2 database backups']);
    expect(c!.ok).toBe(true);
  });

  it('checks a host backups folder of another size on its own, with a smaller headroom', () => {
    const checks = planSpace(docker(4 * GB), { where: '/backups', freeBytes: 1 * GB, totalBytes: 2000 * GB }, { imageBytes: 0.4 * GB, backupBytes: 0.5 * GB }, 3 * GB, true);
    expect(checks.map((c) => [c.label, c.requiredBytes, c.ok])).toEqual([
      ["Docker's data", Math.ceil(1 * GB * 1.2) + 3 * GB, false],
      ['the backups', Math.ceil(1 * GB * 1.2) + 512 * MB, false],
    ]);
  });

  it('puts the backups on Docker when their folder could not be measured', () => {
    const checks = planSpace(docker(10 * GB), null, { imageBytes: 0, backupBytes: 1 * GB }, 3 * GB);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.parts).toEqual([{ what: '2 database backups', bytes: 2 * GB }]);
  });

  it('counts the dumps on both when unsure where they land', () => {
    // a volume whose numbers differ from Docker's root: perhaps another dataset
    const checks = planSpace(docker(20 * GB), { where: '/backups', freeBytes: 5 * GB, totalBytes: 50 * GB }, { imageBytes: 1 * GB, backupBytes: 1 * GB }, 3 * GB, false);
    expect(checks.map((c) => [c.label, c.parts.map((p) => p.what)])).toEqual([
      ["Docker's data", ['the new images, unpacked', '2 database backups']],
      ['the backups', ['2 database backups']],
    ]);
  });

  it('tells one filesystem from two', () => {
    const at = (free: number, total: number | null) => ({ where: '/backups', freeBytes: free, totalBytes: total });
    // a named volume reports the data root's numbers
    expect(filesystemRelation(docker(10 * GB), at(10 * GB, 100 * GB), false)).toBe('same');
    // ZFS datasets / btrfs subvolumes of one pool: other totals, the same free space (read moments apart)
    expect(filesystemRelation(docker(10 * GB), at(10 * GB + 20 * MB, 400 * GB), true)).toBe('same');
    // a host folder on another disk
    expect(filesystemRelation(docker(10 * GB), at(300 * GB, 2000 * GB), true)).toBe('separate');
    // a volume with other numbers, or sizes unknown: unsure
    expect(filesystemRelation(docker(10 * GB), at(300 * GB, 2000 * GB), false)).toBe('unsure');
    expect(filesystemRelation(docker(10 * GB, null), at(300 * GB, null), true)).toBe('unsure');
  });

  it('reads TAGAVE_BACKUP_DIR as a host folder only when it is a path', () => {
    expect(backupsOnHostFolder('/mnt/nas/backups')).toBe(true);
    expect(backupsOnHostFolder('./backups')).toBe(true);
    expect(backupsOnHostFolder('backups')).toBe(false);
    expect(backupsOnHostFolder(undefined)).toBe(false);
  });

  it('says nothing when there is room, and how much to free when not', () => {
    const fits = planSpace(docker(50 * GB), null, { imageBytes: 1 * GB, backupBytes: 1 * GB }, 3 * GB);
    expect(spaceShortMessage(fits)).toBeNull();
    const short = planSpace(docker(5 * GB), null, { imageBytes: 1 * GB, backupBytes: 1 * GB }, 3 * GB);
    const msg = spaceShortMessage(short)!;
    expect(msg).toMatch(/^not enough free disk space: Docker's data on \/var\/lib\/docker has 5\.0 GB free and the update needs 8\.4 GB\. Free at least 3\.4 GB; safe to delete: docker builder prune/);
    expect(msg).not.toMatch(/unknown/);
  });

  it('formats sizes', () => {
    expect(formatBytes(700 * MB)).toBe('700 MB');
    expect(formatBytes(2.25 * GB)).toBe('2.3 GB');
    expect(formatBytes(-5)).toBe('0 MB');
  });
});

describe('image references', () => {
  it.each([
    ['postgres:17-alpine', { registry: 'registry-1.docker.io', repository: 'library/postgres', reference: '17-alpine' }],
    ['deluan/navidrome:0.64.0', { registry: 'registry-1.docker.io', repository: 'deluan/navidrome', reference: '0.64.0' }],
    ['ghcr.io/xooxoxxo/tagave-app:0.9.0', { registry: 'ghcr.io', repository: 'xooxoxxo/tagave-app', reference: '0.9.0' }],
    ['localhost:5000/tagave-app', { registry: 'localhost:5000', repository: 'tagave-app', reference: 'latest' }],
    ['ghcr.io/x/y@sha256:abc', { registry: 'ghcr.io', repository: 'x/y', reference: 'sha256:abc' }],
  ])('%s', (ref, want) => {
    expect(parseImageRef(ref)).toEqual(want);
  });

  it('names architectures the way image indexes do', () => {
    expect(dockerArch('x64')).toBe('amd64');
    expect(dockerArch('arm64')).toBe('arm64');
  });
});

describe('the registry client', () => {
  function registry() {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      json: async () => body,
    });
    const fetchImpl: Fetch = async (url, init) => {
      seen.push({ url, auth: init.headers['Authorization'] });
      if (url.startsWith('https://ghcr.io/token?')) return json(200, { token: 'T' });
      if (init.headers['Authorization'] !== 'Bearer T') {
        return json(401, {}, { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x/app:pull"' });
      }
      if (url.endsWith('/manifests/0.9.0')) {
        return json(200, {
          manifests: [
            { digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } },
            { digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } },
            { digest: 'sha256:att', platform: { os: 'unknown', architecture: 'unknown' } },
          ],
        });
      }
      if (url.endsWith('/manifests/sha256:arm')) return json(200, { layers: [{ digest: 'sha256:l1', size: 10 }, { digest: 'sha256:l2', size: 20 }] });
      return json(404, {});
    };
    return { seen, fetchImpl };
  }

  it('gets a token, picks this architecture from the index and lists its layers', async () => {
    const { seen, fetchImpl } = registry();
    const layers = registryClient(fetchImpl, 'arm64');
    expect(await layers('ghcr.io/x/app:0.9.0')).toEqual([{ digest: 'sha256:l1', size: 10 }, { digest: 'sha256:l2', size: 20 }]);
    expect(seen[1]!.url).toBe('https://ghcr.io/token?service=ghcr.io&scope=repository%3Ax%2Fapp%3Apull');
    // the token is reused for the second manifest
    expect(seen.filter((s) => s.url.startsWith('https://ghcr.io/token')).length).toBe(1);
  });

  it('fails clearly for an architecture the index lacks, or a missing tag', async () => {
    const { fetchImpl } = registry();
    await expect(registryClient(fetchImpl, 'riscv64')('ghcr.io/x/app:0.9.0')).rejects.toThrow('has no image for linux/riscv64');
    await expect(registryClient(fetchImpl, 'arm64')('ghcr.io/x/app:0.10.0')).rejects.toThrow('answered 404');
  });
});

/** A docker CLI and registry with the given images; `here` are present locally. */
function probe(opts: {
  here?: string[];
  images?: Record<string, Layer[]>;
  target?: string[];
  current?: string[];
  composeFails?: boolean;
  free?: number;
  /** The digest each local image was pulled as. */
  pulledAs?: Record<string, string>;
  newest?: { name: string; bytes: number } | null;
  dbSize?: string;
  hang?: boolean;
}) {
  const logs: string[] = [];
  const asked: string[] = [];
  const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
  const bad: CommandResult = { code: 1, stdout: '', stderr: 'no' };
  const deps: SpaceProbeDeps = {
    docker: async (args, o) => {
      const a = args.join(' ');
      if (a === 'compose config --images') {
        if (opts.composeFails) return bad;
        return ok(((o?.env?.['TAGAVE_VERSION'] ? opts.target : opts.current) ?? []).join('\n'));
      }
      if (args[0] === 'image') {
        const ref = args.at(-1)!;
        if (!(opts.here ?? []).includes(ref)) return bad;
        if (args.includes('{{json .RepoDigests}}')) return ok(JSON.stringify(opts.pulledAs?.[ref] ? [opts.pulledAs[ref]] : []));
        return ok('sha256:x');
      }
      if (a.startsWith('compose exec -T postgres')) return opts.dbSize ? ok(`${opts.dbSize}\n`) : bad;
      if (args[0] === 'info') return ok('/srv/docker\n');
      if (a.startsWith('compose exec -T app node -e')) return ok(JSON.stringify({ dir: '/backups', newest: opts.newest === undefined ? { name: 'tagave-x.pgdump', bytes: 300 * MB } : opts.newest, disk: { free: opts.free ?? 10 * GB, total: 100 * GB } }));
      return bad;
    },
    statfs: async () => ({ bsize: 1024, bavail: (opts.free ?? 10 * GB) / 1024, blocks: (100 * GB) / 1024 }),
    layers: async (ref, signal) => {
      asked.push(ref);
      if (opts.hang) await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      const l = opts.images?.[ref];
      if (!l) throw new Error('unknown to the registry');
      return l;
    },
    log: (level, m) => logs.push(`${level}: ${m}`),
    ...(opts.hang ? { registryBudgetMs: 50 } : {}),
  };
  return { deps, logs, asked };
}

describe('measuring the download', () => {
  const base = { digest: 'sha256:base', size: 100 * MB };
  const images = {
    'r/tagave-app@sha256:pulled1': [base, { digest: 'sha256:app1', size: 50 * MB }],
    // what the tag points at in the registry today, not what is on disk
    'r/tagave-app:1': [{ digest: 'sha256:retagged', size: 1 }],
    'r/tagave-app:2': [base, { digest: 'sha256:app2', size: 60 * MB }],
    'r/tagave-worker:2': [base, { digest: 'sha256:app2', size: 60 * MB }, { digest: 'sha256:w2', size: 5 * MB }],
  };

  it('counts each new layer once, and none the images here already have (by the digest they were pulled as)', async () => {
    const { deps, asked } = probe({
      images,
      here: ['r/tagave-app:1', 'pg:17'],
      pulledAs: { 'r/tagave-app:1': 'r/tagave-app@sha256:pulled1', 'pg:17': 'pg@sha256:p' },
      current: ['r/tagave-app:1', 'pg:17'],
      target: ['r/tagave-app:2', 'r/tagave-worker:2', 'pg:17'],
    });
    expect(await imageDownloadBytes(deps, '2', 4)).toBe(65 * MB);
    // nothing asked about images that are not being pulled, nor about the moved tag
    expect(asked.sort()).toEqual(['r/tagave-app:2', 'r/tagave-app@sha256:pulled1', 'r/tagave-worker:2']);
  });

  it('counts every layer when the image here has no pulled digest (built here)', async () => {
    const { deps } = probe({ images, here: ['r/tagave-app:1'], current: ['r/tagave-app:1'], target: ['r/tagave-app:2'] });
    expect(await imageDownloadBytes(deps, '2', 4)).toBe(160 * MB);
  });

  it('gives the registry one time budget, then counts 1 GB per image', async () => {
    const { deps, logs } = probe({ images, hang: true, target: ['r/tagave-app:2', 'r/tagave-worker:2'] });
    expect(await imageDownloadBytes(deps, '2', 4)).toBe(2 * GB);
    expect(logs.at(-1)).toMatch(/^warn: space: the registry did not describe the images within 0 s; counting 1\.0 GB for each of the 2 to download/);
  });

  it('counts nothing when the target images are here already (a retry)', async () => {
    const { deps } = probe({ images, here: ['r/tagave-app:2'], target: ['r/tagave-app:2'] });
    expect(await imageDownloadBytes(deps, '2', 4)).toBe(0);
  });

  it('assumes 1 GB for an image the registry does not describe, and logs it', async () => {
    const { deps, logs } = probe({ images: {}, target: ['r/tagave-app:2'] });
    expect(await imageDownloadBytes(deps, '2', 4)).toBe(1 * GB);
    expect(logs.join('\n')).toMatch(/could not read the size of r\/tagave-app:2 from its registry \(unknown to the registry\); counting 1\.0 GB/);
  });

  it('assumes 1 GB per service when compose cannot list the images', async () => {
    const { deps, logs } = probe({ composeFails: true });
    expect(await imageDownloadBytes(deps, '2', 5)).toBe(5 * GB);
    expect(logs.join('\n')).toMatch(/did not list the 2 images/);
  });
});

describe('checkSpace', () => {
  it('measures everything and refuses with the numbers when short', async () => {
    // 1 GB of new layers → 2.5 GB unpacked; 2 × 300 MB dumps; × 1.2 + 3 GB = 6.72 GB
    const { deps, logs } = probe({ images: { 'r/a:2': [{ digest: 'd', size: 1 * GB }] }, target: ['r/a:2'], free: 6 * GB });
    const res = await checkSpace(deps, { target: '2', imageCount: 1, dockerHeadroom: 3 * GB });
    expect(res.checks).toHaveLength(1);
    expect(res.problem).toMatch(/Docker's data on \/srv\/docker has 6\.0 GB free and the update needs 6\.7 GB/);
    expect(logs.at(-1)).toMatch(/^warn: space: Docker's data \(\/srv\/docker\): 6\.0 GB free, needs 6\.7 GB \(the new images, unpacked ~2\.5 GB, 2 database backups ~600 MB, 20 % margin, 3\.0 GB left free\)/);
  });

  it('counts only the backups once the images are pulled', async () => {
    const { deps } = probe({ free: 4 * GB });
    const res = await checkSpace(deps, { target: null, imageCount: 1, dockerHeadroom: 3 * GB });
    expect(res.problem).toBeNull();
    expect(res.checks[0]!.requiredBytes).toBe(Math.ceil(600 * MB * 1.2) + 3 * GB);
  });
});

describe('the backup estimate', () => {
  it('counts the database without its indexes when there is no dump yet', async () => {
    const { deps, logs } = probe({ newest: null, dbSize: `${1000 * MB} ${400 * MB}`, free: 50 * GB });
    const res = await checkSpace(deps, { target: null, imageCount: 1, dockerHeadroom: 3 * GB });
    expect(res.checks[0]!.parts).toEqual([{ what: '2 database backups', bytes: 1200 * MB }]);
    expect(logs).toContain('info: space: no backup in /backups yet; counting the database without its indexes, 600 MB (1000 MB in all), per backup');
  });
});

describe('the backups probe', () => {
  it('is valid JavaScript that prints one JSON line', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const dir = await mkdtemp(join(tmpdir(), 'tagave-backups-'));
    try {
      await writeFile(join(dir, 'tagave-a.pgdump'), 'x'.repeat(10));
      await writeFile(join(dir, 'notes.txt'), 'x'.repeat(99));
      const out = JSON.parse(execFileSync(process.execPath, ['-e', BACKUPS_PROBE_JS], { env: { BACKUP_DIR: dir } }).toString()) as {
        dir: string;
        newest: { name: string; bytes: number };
        disk: { free: number; total: number };
      };
      expect(out.dir).toBe(dir);
      expect(out.newest).toMatchObject({ name: 'tagave-a.pgdump', bytes: 10 });
      expect(out.disk.free).toBeGreaterThan(0);
      expect(out.disk.total).toBeGreaterThanOrEqual(out.disk.free);
      // like the doctor: CACHE_DIR/backups without BACKUP_DIR, else /backups
      const run = (env: Record<string, string>) => (JSON.parse(execFileSync(process.execPath, ['-e', BACKUPS_PROBE_JS], { env }).toString()) as { dir: string }).dir;
      expect(run({ CACHE_DIR: '/cache' })).toBe('/cache/backups');
      expect(run({})).toBe('/backups');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
