import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkPulledDigest, pullVerified } from './modules.js';
import {
  ReleaseRefused, envPins, imageForService, loadTrustedKeys, parseManifest, parseSignature, pinnedRef, platformOf, verifyRelease, type ReleaseCheck,
} from './release.js';
import { digest, signed, testKey, testManifest } from './release.testkit.js';

const KEY = testKey();
const OTHER = testKey();

function refusal(fn: () => unknown): { check: ReleaseCheck; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof ReleaseRefused) return { check: err.check, message: err.message };
    throw err;
  }
  throw new Error('not refused');
}

describe('verifyRelease', () => {
  const good = signed(KEY, testManifest('0.10.0'));

  it('accepts a manifest signed by a trusted key, for the version asked, not older than what runs', () => {
    const v = verifyRelease(good.text, good.signature, [OTHER.trusted, KEY.trusted], { version: '0.10.0', running: '0.9.2', floor: '0.9.2' });
    expect(v.manifest.version).toBe('0.10.0');
    expect(v.keyId).toBe(KEY.trusted.id);
    expect(v.manifest.modules.map((m) => m.id)).toEqual(['player', 'dummy']);
  });

  it('refuses a manifest changed after signing (one digest swapped)', () => {
    const tampered = good.text.replace(digest('a2'), digest('99'));
    expect(tampered).not.toBe(good.text);
    const r = refusal(() => verifyRelease(tampered, good.signature, [KEY.trusted], { version: '0.10.0' }));
    expect(r.check).toBe('signature');
    expect(r.message).toMatch(/does not match its signature: it was changed after tagave signed it/);
  });

  it('refuses a manifest signed by another key, naming that key', () => {
    const forged = signed(OTHER, testManifest('0.10.0'));
    const r = refusal(() => verifyRelease(forged.text, forged.signature, [KEY.trusted], { version: '0.10.0' }));
    expect(r.check).toBe('signer');
    expect(r.message).toContain(`signed by key ${OTHER.trusted.id}, which is not a tagave release key this updater trusts (${KEY.trusted.id})`);
  });

  it('refuses a signature made by an untrusted key that claims a trusted key id', () => {
    const forged = signed(OTHER, testManifest('0.10.0'));
    const lying = forged.signature.replace(OTHER.trusted.id, KEY.trusted.id);
    expect(refusal(() => verifyRelease(forged.text, lying, [KEY.trusted], { version: '0.10.0' })).check).toBe('signature');
  });

  it('refuses a missing or garbled signature, and everything when it holds no key', () => {
    expect(refusal(() => verifyRelease(good.text, null, [KEY.trusted], { version: '0.10.0' })).check).toBe('unsigned');
    expect(refusal(() => verifyRelease(good.text, 'hello', [KEY.trusted], { version: '0.10.0' })).check).toBe('unsigned');
    const r = refusal(() => verifyRelease(good.text, good.signature, [], { version: '0.10.0' }));
    expect(r.check).toBe('no_keys');
  });

  it('refuses a manifest of another version than the one asked for', () => {
    const r = refusal(() => verifyRelease(good.text, good.signature, [KEY.trusted], { version: '0.10.1' }));
    expect(r).toEqual({ check: 'version', message: 'the signed manifest is for 0.10.0, not 0.10.1' });
  });

  it('refuses a downgrade, and an older signed manifest replayed against a newer install', () => {
    const old = signed(KEY, testManifest('0.9.1'));
    const down = refusal(() => verifyRelease(old.text, old.signature, [KEY.trusted], { version: '0.9.1', running: '0.10.0' }));
    expect(down.check).toBe('downgrade');
    expect(down.message).toMatch(/0\.9\.1, older than 0\.10\.0, which runs here/);
    // .env was set back by hand to 0.9.1, but this install already ran 0.10.0
    const replay = refusal(() => verifyRelease(old.text, old.signature, [KEY.trusted], { version: '0.9.1', running: '0.9.1', floor: '0.10.0' }));
    expect(replay.check).toBe('downgrade');
    expect(replay.message).toMatch(/which already ran here/);
  });

  it('refuses a signed file that is not a tagave manifest', () => {
    const notOne = signed(KEY, '{"schema":2}');
    expect(refusal(() => verifyRelease(notOne.text, notOne.signature, [KEY.trusted], { version: '0.10.0' })).check).toBe('format');
  });
});

describe('parseManifest', () => {
  const text = (m: unknown) => JSON.stringify(m);
  it('refuses a module whose compose mounts the Docker socket or runs privileged', () => {
    const m = testManifest('0.10.0');
    const sock = structuredClone(m);
    sock.modules[1]!.compose!.services['dummy']!['volumes'] = ['/var/run/docker.sock:/var/run/docker.sock'];
    expect(() => parseManifest(text(sock))).toThrow(/mounts the Docker socket/);
    const priv = structuredClone(m);
    priv.modules[1]!.compose!.services['dummy']!['privileged'] = true;
    expect(() => parseManifest(text(priv))).toThrow(/uses privileged/);
  });

  it('reads what a module keeps in tagave\'s database; an entry without it (an older catalogue) has none', () => {
    const m = testManifest('0.10.0');
    const parsed = parseManifest(text(m));
    expect(parsed.modules[0]!.appData).toEqual(m.modules[0]!.appData);
    expect(parsed.modules[1]!.appData).toBeUndefined();
    const noHistory = structuredClone(m);
    noHistory.modules[0]!.appData = { removes: 'Deletes its rows.', keeps: null, history: null };
    expect(parseManifest(text(noHistory)).modules[0]!.appData).toEqual({ removes: 'Deletes its rows.', keeps: null, history: null });
    const bad = structuredClone(m) as unknown as { modules: Array<Record<string, unknown>> };
    bad.modules[0]!['appData'] = { removes: '', history: null };
    expect(() => parseManifest(text(bad))).toThrow(/appData.removes/);
    bad.modules[0]!['appData'] = { removes: 'x', history: 3 };
    expect(() => parseManifest(text(bad))).toThrow(/appData.history/);
  });

  it('refuses a module setting that touches tagave itself or a digest pin', () => {
    const m = testManifest('0.10.0');
    m.modules[1]!.settings = [{ key: 'TAGAVE_VERSION', kind: 'value', value: '0.1.0' }];
    expect(() => parseManifest(text(m))).toThrow(/setting TAGAVE_VERSION/);
    m.modules[1]!.settings = [{ key: 'TAGAVE_DIGEST_APP', kind: 'value', value: 'x' }];
    expect(() => parseManifest(text(m))).toThrow(/setting TAGAVE_DIGEST_APP/);
  });

  it('refuses an image ref with a digest in it, a module image the manifest does not pin, a bad digest', () => {
    const a = testManifest('0.10.0');
    a.images['app']!.ref = `ghcr.io/xooxoxxo/tagave-app:0.10.0@${digest('a')}`;
    expect(() => parseManifest(text(a))).toThrow(/without a digest/);
    const b = testManifest('0.10.0');
    b.modules[1]!.services = [{ name: 'dummy', image: 'nope' }];
    expect(() => parseManifest(text(b))).toThrow(/does not pin/);
    const c = testManifest('0.10.0');
    c.images['app']!.platforms['linux/amd64'] = 'sha256:short';
    expect(() => parseManifest(text(c))).toThrow(/platform linux\/amd64/);
  });
});

describe('pins', () => {
  const m = testManifest('0.10.0');
  it('picks this platform, with DOCKER_DEFAULT_PLATFORM winning', () => {
    expect(platformOf('arm64')).toBe('linux/arm64');
    expect(platformOf('arm64', 'linux/amd64')).toBe('linux/amd64');
    expect(envPins(m, 'linux/arm64')).toMatchObject({ TAGAVE_DIGEST_APP: digest('a2'), TAGAVE_DIGEST_PLAYER: digest('e2'), TAGAVE_DIGEST_POSTGRES: digest('d2') });
    expect(pinnedRef(m, 'player', 'linux/amd64')).toBe(`deluan/navidrome:0.64.0@${digest('e1')}`);
    expect(imageForService(m, 'worker-files')).toBe('worker');
    expect(imageForService(m, 'dummy')).toBe('dummy');
  });
  it('refuses a platform the release has no image for', () => {
    expect(refusal(() => envPins(m, 'linux/riscv64')).check).toBe('architecture');
  });
});

describe('the pulled digest', () => {
  const m = testManifest('0.10.0');
  const docker = (repoDigests: string[], pullCode = 0) => {
    const calls: string[] = [];
    const run = async (args: string[]) => {
      calls.push(args.join(' '));
      if (args[0] === 'pull') return { code: pullCode, stdout: '', stderr: pullCode ? 'manifest unknown' : '' };
      if (args[0] === 'image') return { code: 0, stdout: JSON.stringify(repoDigests), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    return { run, calls };
  };

  it('pulls by digest, checks it and tags the image', async () => {
    const d = docker([`deluan/navidrome@${digest('e2')}`]);
    await pullVerified(d.run, m, 'player', 'linux/arm64', () => undefined, 1000);
    expect(d.calls).toEqual([
      `pull deluan/navidrome:0.64.0@${digest('e2')}`,
      `image inspect --format {{json .RepoDigests}} deluan/navidrome:0.64.0@${digest('e2')}`,
      `tag deluan/navidrome:0.64.0@${digest('e2')} deluan/navidrome:0.64.0`,
    ]);
  });

  it('refuses an image whose digest differs from the manifest, and one the registry does not hold', async () => {
    const d = docker([`docker.io/deluan/navidrome@${digest('77')}`]);
    await expect(pullVerified(d.run, m, 'player', 'linux/arm64', () => undefined, 1000)).rejects.toMatchObject({
      check: 'digest',
      message: expect.stringMatching(/is sha256:7{64}, not sha256:e2/),
    });
    expect(d.calls.some((c) => c.startsWith('tag'))).toBe(false);
    await expect(pullVerified(docker([], 1).run, m, 'player', 'linux/arm64', () => undefined, 1000)).rejects.toMatchObject({ check: 'digest' });
    await expect(checkPulledDigest(docker([]).run, 'deluan/navidrome:0.64.0', digest('e2'))).rejects.toMatchObject({ check: 'digest' });
  });

  it('pulls tagave images from TAGAVE_REGISTRY', async () => {
    const d = docker([`mirror.example/tagave-app@${digest('a2')}`]);
    await pullVerified(d.run, m, 'app', 'linux/arm64', () => undefined, 1000, 'mirror.example');
    expect(d.calls[0]).toBe(`pull mirror.example/tagave-app:0.10.0@${digest('a2')}`);
  });
});

describe('keys and signature files', () => {
  it('loads the PEM keys of a folder, refuses a non-Ed25519 key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tagave-keys-'));
    try {
      expect(await loadTrustedKeys(join(dir, 'none'))).toEqual([]);
      await writeFile(join(dir, 'a.pem'), createPublicKey(KEY.privateKey).export({ type: 'spki', format: 'pem' }).toString());
      await writeFile(join(dir, 'notes.txt'), 'ignored');
      expect((await loadTrustedKeys(dir)).map((k) => k.id)).toEqual([KEY.trusted.id]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads the three-line signature file', () => {
    const { signature } = signed(KEY, testManifest('0.10.0'));
    expect(signature.split('\n')[0]).toBe('tagave-release-signature v1');
    expect(parseSignature(signature).keyId).toBe(KEY.trusted.id);
    expect(parseSignature(signature).signature).toHaveLength(64);
  });
});
