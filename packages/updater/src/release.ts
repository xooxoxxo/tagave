/**
 * The signed release manifest: what a release consists of, pinned by
 * digest, and the proof that the tagave project published it.
 *
 * CI writes `release-manifest.json` for every release tag (every image of
 * the release, tagave's and the third-party ones, by digest per platform;
 * the module catalogue; sha256 of the installer and the compose files) and
 * signs its exact bytes with the project's Ed25519 release key. The private
 * key lives only in the repository's "release" environment; the public keys
 * ship inside the updater image (/opt/tagave/release-keys/*.pem) and inside
 * install-tagave.sh.
 *
 * The signature file is three lines:
 *
 *   tagave-release-signature v1
 *   key <key id>
 *   sig <base64 of the 64-byte Ed25519 signature>
 *
 * The key id is the first 16 hex characters of the sha256 of the public key
 * (DER, SubjectPublicKeyInfo), so a refusal can say "signed by another key"
 * apart from "changed after signing". `openssl pkeyutl -verify -rawin`
 * checks the same signature (docs/security.md).
 *
 * Nothing here needs the network: the updater sits on an internal network
 * with no route out, and the keys travel inside its image.
 */
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleEntry, ModuleSetting, ReleaseImage, ReleaseManifest } from '@tagave/shared/modules';
import { compareReleases } from './image-hygiene.js';

export const MANIFEST_FILE = 'release-manifest.json';
export const SIGNATURE_FILE = 'release-manifest.json.sig';
/** Where the updater image keeps the public release keys. */
export const IMAGE_KEYS_DIR = '/opt/tagave/release-keys';
const SIGNATURE_HEADER = 'tagave-release-signature v1';
/** A manifest is small; anything bigger is not one. */
export const MAX_MANIFEST_BYTES = 256 * 1024;

/**
 * Which check refused a manifest:
 *   no_keys       this updater carries no release key
 *   unsigned      no signature came with it
 *   signer        signed, but by a key this updater does not trust
 *   signature     the signature does not match: the manifest changed after signing
 *   format        not a tagave release manifest
 *   version       it describes another release than the one asked for
 *   downgrade     it is older than what runs here (or than a release this install already ran)
 *   architecture  it has no image for this computer
 *   digest        a pulled image is not the one the manifest pins
 */
export type ReleaseCheck = 'no_keys' | 'unsigned' | 'signer' | 'signature' | 'format' | 'version' | 'downgrade' | 'architecture' | 'digest';

export class ReleaseRefused extends Error {
  constructor(readonly check: ReleaseCheck, message: string) {
    super(message);
    this.name = 'ReleaseRefused';
  }
}

export interface TrustedKey {
  id: string;
  key: KeyObject;
}

export function keyId(key: KeyObject): string {
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/** An Ed25519 public key in PEM; anything else is refused. */
export function trustedKeyFromPem(pem: string): TrustedKey {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`a release key must be Ed25519, not ${key.asymmetricKeyType ?? 'unknown'}`);
  return { id: keyId(key), key };
}

/** Every *.pem in `dir`; none (or no folder) is an empty list, which refuses every manifest. */
export async function loadTrustedKeys(dir: string): Promise<TrustedKey[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.pem')).sort();
  } catch {
    return [];
  }
  const keys: TrustedKey[] = [];
  for (const name of names) keys.push(trustedKeyFromPem(await readFile(join(dir, name), 'utf8')));
  return keys;
}

/** The signature file for `manifest` (its exact bytes), with an Ed25519 private key. */
export function signManifest(manifest: string | Buffer, privateKey: KeyObject): string {
  const pub = createPublicKey(privateKey);
  const sig = sign(null, Buffer.from(manifest), privateKey).toString('base64');
  return `${SIGNATURE_HEADER}\nkey ${keyId(pub)}\nsig ${sig}\n`;
}

export function parseSignature(text: string): { keyId: string; signature: Buffer } {
  const lines = text.replace(/\r/g, '').trim().split('\n');
  const key = lines.find((l) => l.startsWith('key '))?.slice(4).trim();
  const sig = lines.find((l) => l.startsWith('sig '))?.slice(4).trim();
  if (lines[0] !== SIGNATURE_HEADER || !key || !sig || !/^[0-9a-f]{16}$/.test(key) || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) {
    throw new ReleaseRefused('unsigned', 'the release signature file is not one tagave writes');
  }
  const signature = Buffer.from(sig, 'base64');
  if (signature.length !== 64) throw new ReleaseRefused('unsigned', 'the release signature file is not one tagave writes');
  return { keyId: key, signature };
}

// -- the manifest's shape ------------------------------------------------------

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ENV_KEY_RE = /^TAGAVE_[A-Z0-9_]+$/;
const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const SERVICE_RE = /^[a-z][a-z0-9_-]{0,62}$/;
const RELEASE_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/;
const PLATFORM_RE = /^linux\/[a-z0-9]+(?:\/v[0-9])?$/;
/** Settings a module may not touch: they belong to tagave itself. */
const RESERVED_KEYS = new Set(['TAGAVE_VERSION', 'TAGAVE_REGISTRY', 'TAGAVE_ROLE', 'TAGAVE_INSTALL_DIR', 'TAGAVE_UPDATER_URL', 'TAGAVE_PORT', 'TAGAVE_BACKUP_DIR']);
/** Compose keys a module's own services may not use: nothing that reaches outside its containers. */
const FORBIDDEN_SERVICE_KEYS = ['privileged', 'pid', 'ipc', 'network_mode', 'cap_add', 'devices', 'userns_mode', 'security_opt', 'cgroup_parent'];

function bad(what: string): never {
  throw new ReleaseRefused('format', `not a tagave release manifest: ${what}`);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, what: string): string => (typeof v === 'string' && v.length > 0 && v.length <= 2000 ? v : bad(what));

function parseImage(name: string, v: unknown): ReleaseImage {
  if (!isObj(v)) bad(`image ${name}`);
  const ref = str(v['ref'], `image ${name} has no ref`);
  if (/@/.test(ref) || !/:[^/]+$/.test(ref)) bad(`image ${name}: ref must be a tagged name without a digest`);
  const env = v['env'] === null || v['env'] === undefined ? null : str(v['env'], `image ${name} env`);
  if (env !== null && !ENV_KEY_RE.test(env)) bad(`image ${name}: env ${env}`);
  const index = v['index'] === null || v['index'] === undefined ? null : str(v['index'], `image ${name} index`);
  if (index !== null && !DIGEST_RE.test(index)) bad(`image ${name}: index digest`);
  if (!isObj(v['platforms'])) bad(`image ${name} has no platforms`);
  const platforms: Record<string, string> = {};
  for (const [p, d] of Object.entries(v['platforms'])) {
    if (!PLATFORM_RE.test(p) || typeof d !== 'string' || !DIGEST_RE.test(d)) bad(`image ${name}: platform ${p}`);
    platforms[p] = d;
  }
  if (Object.keys(platforms).length === 0) bad(`image ${name} has no platforms`);
  const services = v['services'] ?? [];
  if (!Array.isArray(services) || services.some((x) => typeof x !== 'string' || !SERVICE_RE.test(x))) bad(`image ${name}: services`);
  return { ref, env, index, platforms, services: services as string[] };
}

function parseSetting(id: string, v: unknown): ModuleSetting {
  if (!isObj(v)) bad(`module ${id}: a setting`);
  const key = str(v['key'], `module ${id}: a setting has no key`);
  const upper = id.toUpperCase().replace(/-/g, '_');
  if (!ENV_KEY_RE.test(key) || RESERVED_KEYS.has(key) || key.startsWith('TAGAVE_DIGEST_')) bad(`module ${id}: setting ${key}`);
  if (!key.startsWith('TAGAVE_MODULE_') && !key.startsWith(`TAGAVE_${upper}_`)) {
    bad(`module ${id}: setting ${key} must start with TAGAVE_MODULE_ or TAGAVE_${upper}_`);
  }
  switch (v['kind']) {
    case 'secret':
      return { key, kind: 'secret' };
    case 'value': {
      const value = typeof v['value'] === 'string' ? v['value'] : bad(`module ${id}: setting ${key} has no value`);
      if (!/^[A-Za-z0-9._:/@,-]*$/.test(value)) bad(`module ${id}: setting ${key} has an unexpected value`);
      return { key, kind: 'value', value, ...(v['clearOnDisable'] === true ? { clearOnDisable: true } : {}) };
    }
    case 'port': {
      const d = v['default'];
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 65535) bad(`module ${id}: setting ${key} port`);
      return { key, kind: 'port', default: d };
    }
    default:
      return bad(`module ${id}: setting ${key} kind`);
  }
}

function parseCompose(id: string, profile: string, services: string[], v: unknown): ModuleEntry['compose'] {
  if (v === null || v === undefined) return null;
  if (!isObj(v) || !isObj(v['services'])) bad(`module ${id}: compose`);
  for (const k of Object.keys(v)) if (k !== 'services' && k !== 'volumes') bad(`module ${id}: compose may hold services and volumes only`);
  const out: NonNullable<ModuleEntry['compose']> = { services: {} };
  for (const [name, svc] of Object.entries(v['services'])) {
    if (!services.includes(name) || !isObj(svc)) bad(`module ${id}: compose service ${name} is not one of its services`);
    const profiles = svc['profiles'];
    if (!Array.isArray(profiles) || profiles.length !== 1 || profiles[0] !== profile) bad(`module ${id}: compose service ${name} must have profiles: [${profile}]`);
    if ('image' in svc || 'build' in svc) bad(`module ${id}: compose service ${name} names its image in services, not in compose`);
    for (const k of FORBIDDEN_SERVICE_KEYS) if (k in svc) bad(`module ${id}: compose service ${name} uses ${k}`);
    if (JSON.stringify(svc).includes('docker.sock')) bad(`module ${id}: compose service ${name} mounts the Docker socket`);
    out.services[name] = svc;
  }
  if (v['volumes'] !== undefined) {
    if (!isObj(v['volumes'])) bad(`module ${id}: compose volumes`);
    out.volumes = v['volumes'] as Record<string, Record<string, unknown> | null>;
  }
  return out;
}

function parseModule(v: unknown, images: Record<string, ReleaseImage>): ModuleEntry {
  if (!isObj(v)) bad('a module');
  const id = str(v['id'], 'a module has no id');
  if (!ID_RE.test(id)) bad(`module id ${id}`);
  const profile = str(v['profile'], `module ${id} has no profile`);
  if (!ID_RE.test(profile) || ['app', 'files', 'updater'].includes(profile)) bad(`module ${id}: profile ${profile}`);
  const minVersion = str(v['minVersion'], `module ${id} has no minVersion`);
  if (!RELEASE_RE.test(minVersion)) bad(`module ${id}: minVersion`);
  if (!Array.isArray(v['services']) || v['services'].length === 0) bad(`module ${id} has no services`);
  const services = (v['services'] as unknown[]).map((s) => {
    if (!isObj(s)) bad(`module ${id}: a service`);
    const name = str(s['name'], `module ${id}: a service has no name`);
    const image = str(s['image'], `module ${id}: service ${name} has no image`);
    if (!SERVICE_RE.test(name) || ['app', 'postgres', 'updater'].includes(name) || name.startsWith('worker-')) bad(`module ${id}: service ${name}`);
    if (!images[image]) bad(`module ${id}: service ${name} runs image ${image}, which the manifest does not pin`);
    return { name, image };
  });
  const names = services.map((s) => s.name);
  const list = (key: string, re: RegExp): string[] => {
    const raw = v[key] ?? [];
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || !re.test(x))) bad(`module ${id}: ${key}`);
    return raw as string[];
  };
  const estimate = v['estimate'];
  if (!isObj(estimate) || typeof estimate['memoryMb'] !== 'number' || typeof estimate['diskMb'] !== 'number') bad(`module ${id}: estimate`);
  const roles = list('roles', /^(all|app)$/) as Array<'all' | 'app'>;
  if (roles.length === 0) bad(`module ${id}: roles`);
  const settings = Array.isArray(v['settings']) ? (v['settings'] as unknown[]).map((s) => parseSetting(id, s)) : bad(`module ${id}: settings`);
  return {
    id,
    name: str(v['name'], `module ${id} has no name`),
    purpose: str(v['purpose'], `module ${id} has no purpose`),
    minVersion,
    profile,
    services,
    compose: parseCompose(id, profile, names, v['compose']),
    settings,
    restarts: list('restarts', SERVICE_RE),
    volumes: list('volumes', /^[a-z0-9][a-z0-9_.-]{0,62}$/),
    keepsOnRemoval: str(v['keepsOnRemoval'], `module ${id}: keepsOnRemoval`),
    estimate: { memoryMb: estimate['memoryMb'] as number, diskMb: estimate['diskMb'] as number },
    roles,
  };
}

/** Checks the shape; throws ReleaseRefused('format') with what is wrong. */
export function parseManifest(text: string): ReleaseManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    bad('it is not JSON');
  }
  if (!isObj(raw) || raw['schema'] !== 1 || raw['project'] !== 'tagave') bad('schema 1 of project tagave expected');
  const version = str(raw['version'], 'no version');
  if (!RELEASE_RE.test(version)) bad(`version ${version}`);
  if (!isObj(raw['images'])) bad('no images');
  const images: Record<string, ReleaseImage> = {};
  for (const [name, img] of Object.entries(raw['images'])) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) bad(`image name ${name}`);
    images[name] = parseImage(name, img);
  }
  const envs = Object.values(images).map((i) => i.env).filter((e): e is string => e !== null);
  if (new Set(envs).size !== envs.length) bad('two images share an env key');
  if (!Array.isArray(raw['modules'])) bad('no modules');
  const modules = (raw['modules'] as unknown[]).map((m) => parseModule(m, images));
  const ids = modules.map((m) => m.id);
  if (new Set(ids).size !== ids.length) bad('two modules share an id');
  const profiles = modules.map((m) => m.profile);
  if (new Set(profiles).size !== profiles.length) bad('two modules share a profile');
  if (!isObj(raw['files'])) bad('no files');
  const files: Record<string, string> = {};
  for (const [name, sum] of Object.entries(raw['files'])) {
    if (typeof sum !== 'string' || !/^[0-9a-f]{64}$/.test(sum)) bad(`file ${name}`);
    files[name] = sum;
  }
  return {
    schema: 1,
    project: 'tagave',
    version,
    publishedAt: str(raw['publishedAt'], 'no publishedAt'),
    commit: str(raw['commit'], 'no commit'),
    images,
    modules,
    files,
  };
}

// -- verification --------------------------------------------------------------

export interface VerifyExpect {
  /** The release asked for: the manifest must describe exactly this one. */
  version: string;
  /** What runs here: an older manifest is a downgrade (or a replayed old one). */
  running?: string | null;
  /** The newest release this install has run (the updater remembers it): older is refused too. */
  floor?: string | null;
}

export interface VerifiedRelease {
  manifest: ReleaseManifest;
  /** The bytes that were verified, to keep next to the install. */
  text: string;
  signature: string;
  keyId: string;
}

/**
 * Signature, signer, shape, version, downgrade, in that order. Throws
 * ReleaseRefused saying which check failed; nothing is used before this
 * returns.
 */
export function verifyRelease(text: string, signatureText: string | null | undefined, keys: TrustedKey[], expect: VerifyExpect): VerifiedRelease {
  if (keys.length === 0) throw new ReleaseRefused('no_keys', 'this updater carries no release key, so it cannot check any release; it refuses them all');
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new ReleaseRefused('format', 'not a tagave release manifest: it is too large');
  if (!signatureText) throw new ReleaseRefused('unsigned', `the ${expect.version} release manifest came without its signature (${SIGNATURE_FILE})`);
  const sig = parseSignature(signatureText);
  const key = keys.find((k) => k.id === sig.keyId);
  if (!key) {
    throw new ReleaseRefused('signer', `the release manifest is signed by key ${sig.keyId}, which is not a tagave release key this updater trusts (${keys.map((k) => k.id).join(', ')})`);
  }
  if (!verify(null, Buffer.from(text), key.key, sig.signature)) {
    throw new ReleaseRefused('signature', `the release manifest does not match its signature: it was changed after tagave signed it (key ${key.id})`);
  }
  const manifest = parseManifest(text);
  if (manifest.version !== expect.version) {
    throw new ReleaseRefused('version', `the signed manifest is for ${manifest.version}, not ${expect.version}`);
  }
  for (const [label, base] of [['runs here', expect.running], ['already ran here', expect.floor]] as const) {
    if (!base) continue;
    const c = compareReleases(manifest.version, base);
    if (c !== null && c < 0) {
      throw new ReleaseRefused('downgrade', `the signed manifest is for ${manifest.version}, older than ${base}, which ${label}: going back to an older release is refused (an old manifest replayed would look the same)`);
    }
  }
  return { manifest, text, signature: signatureText, keyId: key.id };
}

// -- pins ------------------------------------------------------------------------

/** linux/<arch> for a Docker architecture name, or a DOCKER_DEFAULT_PLATFORM value as it is. */
export function platformOf(arch: string, defaultPlatform?: string | null): string {
  const p = defaultPlatform?.trim();
  if (p) return p;
  return `linux/${arch}`;
}

/** The digest of `image` for `platform`; refuses when the release has none. */
export function digestFor(manifest: ReleaseManifest, image: string, platform: string): string {
  const img = manifest.images[image];
  if (!img) throw new ReleaseRefused('format', `the ${manifest.version} manifest does not pin the image ${image}`);
  const d = img.platforms[platform];
  if (!d) throw new ReleaseRefused('architecture', `${manifest.version} has no ${img.ref} for this computer (${platform})`);
  return d;
}

/** `ref` pinned: repository:tag@sha256:… */
export function pinnedRef(manifest: ReleaseManifest, image: string, platform: string): string {
  return `${manifest.images[image]!.ref}@${digestFor(manifest, image, platform)}`;
}

/**
 * The .env pins of the images compose.yml reads (TAGAVE_DIGEST_APP=sha256:…),
 * for this platform. `only`: the image keys to pin (default: all with an env key).
 */
export function envPins(manifest: ReleaseManifest, platform: string, only?: string[]): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const [name, img] of Object.entries(manifest.images)) {
    if (!img.env || (only && !only.includes(name))) continue;
    pins[img.env] = digestFor(manifest, name, platform);
  }
  return pins;
}

/** The images a module's services run, by key. */
export function moduleImages(entry: ModuleEntry): string[] {
  return [...new Set(entry.services.map((s) => s.image))];
}

/** The image key that runs compose service `service`, from the image list or a module's services. */
export function imageForService(manifest: ReleaseManifest, service: string): string | null {
  for (const [name, img] of Object.entries(manifest.images)) if (img.services.includes(service)) return name;
  for (const m of manifest.modules) for (const s of m.services) if (s.name === service) return s.image;
  return null;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
