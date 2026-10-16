/**
 * Test-only: a throwaway Ed25519 key and signed manifests made with it.
 * Nothing here is trusted by a real updater (its keys come from its image).
 */
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { ModuleEntry, ReleaseManifest } from '@tagave/shared/modules';
import { signManifest, trustedKeyFromPem, type TrustedKey } from './release.js';

export interface TestKey {
  privateKey: KeyObject;
  trusted: TrustedKey;
}

export function testKey(): TestKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, trusted: trustedKeyFromPem(pem) };
}

export const digest = (c: string) => `sha256:${c.repeat(64).slice(0, 64)}`;

export const PLAYER_MODULE: ModuleEntry = {
  id: 'player',
  name: 'Player',
  purpose: 'Plays your albums in tagave and serves phone apps, with a bundled Navidrome.',
  minVersion: '0.9.0',
  profile: 'player',
  services: [{ name: 'player', image: 'player' }],
  compose: null,
  settings: [
    { key: 'TAGAVE_PLAYER_PASSWORD', kind: 'secret' },
    { key: 'TAGAVE_PLAYER_ENCRYPTION_KEY', kind: 'secret' },
    { key: 'TAGAVE_PLAYER_URL', kind: 'value', value: 'http://player:4533', clearOnDisable: true },
    { key: 'TAGAVE_PLAYER_USER', kind: 'value', value: 'admin' },
    { key: 'TAGAVE_PLAYER_PORT', kind: 'port', default: 4533 },
  ],
  restarts: ['app'],
  volumes: ['player-data'],
  keepsOnRemoval: "Navidrome's database (plays, stars) in the player-data volume",
  estimate: { memoryMb: 512, diskMb: 200 },
  roles: ['all'],
};

export const DUMMY_MODULE: ModuleEntry = {
  id: 'dummy',
  name: 'Dummy',
  purpose: 'A test module that does nothing.',
  minVersion: '0.9.0',
  profile: 'dummy',
  services: [{ name: 'dummy', image: 'dummy' }],
  compose: {
    services: { dummy: { profiles: ['dummy'], command: ['sleep', 'infinity'], environment: { TOKEN: '${TAGAVE_MODULE_DUMMY_TOKEN:-}' }, volumes: ['dummy-data:/data'] } },
    volumes: { 'dummy-data': null },
  },
  settings: [{ key: 'TAGAVE_MODULE_DUMMY_TOKEN', kind: 'secret' }],
  restarts: [],
  volumes: ['dummy-data'],
  keepsOnRemoval: 'its dummy-data volume',
  estimate: { memoryMb: 8, diskMb: 10 },
  roles: ['all', 'app'],
};

export function testManifest(version: string, overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  const tagave = (name: string, c: string, services: string[]) => ({
    ref: `ghcr.io/xooxoxxo/tagave-${name}:${version}`,
    env: `TAGAVE_DIGEST_${name.toUpperCase()}`,
    index: digest(c),
    platforms: { 'linux/amd64': digest(`${c}1`), 'linux/arm64': digest(`${c}2`) },
    services,
  });
  return {
    schema: 1,
    project: 'tagave',
    version,
    publishedAt: '2026-10-16T00:00:00Z',
    commit: 'abc123',
    images: {
      app: tagave('app', 'a', ['app']),
      worker: tagave('worker', 'b', ['worker-identify', 'worker-files']),
      updater: tagave('updater', 'c', ['updater']),
      postgres: { ref: 'postgres:16', env: 'TAGAVE_DIGEST_POSTGRES', index: digest('d'), platforms: { 'linux/amd64': digest('d1'), 'linux/arm64': digest('d2') }, services: ['postgres'] },
      player: { ref: 'deluan/navidrome:0.64.0', env: 'TAGAVE_DIGEST_PLAYER', index: digest('e'), platforms: { 'linux/amd64': digest('e1'), 'linux/arm64': digest('e2') }, services: ['player'] },
      dummy: { ref: 'example.test/tagave-dummy:1.0', env: null, index: null, platforms: { 'linux/amd64': digest('f1'), 'linux/arm64': digest('f2') }, services: [] },
    },
    modules: structuredClone([PLAYER_MODULE, DUMMY_MODULE]),
    files: { 'install-tagave.sh': 'f'.repeat(64) },
    ...overrides,
  };
}

export function signed(key: TestKey, manifest: ReleaseManifest | string): { text: string; signature: string } {
  const text = typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest, null, 2)}\n`;
  return { text, signature: signManifest(text, key.privateKey) };
}
