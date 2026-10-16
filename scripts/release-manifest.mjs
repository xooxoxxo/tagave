#!/usr/bin/env node
/**
 * Writes and signs a release's manifest (packages/updater/src/release.ts):
 *
 *   release-manifest.json      every image of the release by digest per
 *                              platform, the module catalogue
 *                              (deploy/modules.json), sha256 of the installer
 *                              and the compose files
 *   release-manifest.json.sig  its Ed25519 signature
 *   install-tagave.sh.sig      the installer's signature (same format)
 *   install-tagave.sh.sha256   "<sha256>  install-tagave.sh"
 *
 * The images are the ones compose.yml runs (with TAGAVE_VERSION set) plus
 * the modules' own, read from their registries anonymously: tagave's from
 * ghcr.io as CI just pushed them, Postgres and Navidrome from Docker Hub.
 * The private key comes from the environment variable named by --key-env
 * (PEM, PKCS#8); the result is verified against deploy/release-keys before
 * anything is written, so a secret that does not match the published key
 * fails the release here.
 *
 *   node scripts/release-manifest.mjs --version 0.10.0 --out release/ \
 *     [--registry ghcr.io/xooxoxxo] [--key-env TAGAVE_RELEASE_SIGNING_KEY | --key-file FILE] \
 *     [--keys deploy/release-keys] [--catalogue deploy/modules.json] [--commit <sha>]
 *
 * Needs `pnpm --filter @tagave/updater... build` (it uses the updater's own
 * signing and checking code) and docker compose (to read compose.yml).
 */
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadTrustedKeys, parseManifest, signManifest, verifyRelease } = await import(join(repo, 'packages/updater/dist/release.js'));

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const version = opt('version');
const out = opt('out');
if (!version || !out) {
  console.error('usage: release-manifest.mjs --version X.Y.Z --out DIR [--registry R] [--key-env NAME] [--keys DIR] [--catalogue FILE] [--commit SHA]');
  process.exit(2);
}
const registry = opt('registry', 'ghcr.io/xooxoxxo');
const keyEnv = opt('key-env', 'TAGAVE_RELEASE_SIGNING_KEY');
const keysDir = resolve(opt('keys', join(repo, 'deploy/release-keys')));
const catalogue = JSON.parse(readFileSync(resolve(opt('catalogue', join(repo, 'deploy/modules.json'))), 'utf8'));
const commit = opt('commit', process.env.GITHUB_SHA ?? 'unknown');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// -- the images compose.yml runs ------------------------------------------------

function composeServices() {
  const text = execFileSync('docker', ['compose', '-f', join(repo, 'deploy/compose.yml'), '--profile', 'app', '--profile', 'files', '--profile', 'updater', '--profile', 'player', 'config', '--format', 'json'], {
    env: { ...process.env, TAGAVE_VERSION: version, TAGAVE_REGISTRY: registry, POSTGRES_PASSWORD: 'x', APP_SECRET: 'x', COMPOSE_PROFILES: '', COMPOSE_FILE: '' },
    encoding: 'utf8',
  });
  return JSON.parse(text).services;
}

/** app, worker, updater for tagave's images; the service name for anything else. */
function imageKey(ref, service) {
  const name = ref.split('/').at(-1).replace(/[:@].*$/, '');
  return name.startsWith('tagave-') ? name.slice('tagave-'.length) : service;
}

/** The .env key compose.yml reads for an image (TAGAVE_DIGEST_APP), if it reads one. */
function envKeyOf(key) {
  const compose = readFileSync(join(repo, 'deploy/compose.yml'), 'utf8');
  const candidate = `TAGAVE_DIGEST_${key.toUpperCase().replace(/-/g, '_')}`;
  return compose.includes(`\${${candidate}:+@\${${candidate}}}`) ? candidate : null;
}

// -- registries ------------------------------------------------------------------

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

function parseRef(ref) {
  let rest = ref;
  let tag = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split('/');
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    return { host: parts[0], repo: parts.slice(1).join('/'), tag };
  }
  return { host: 'registry-1.docker.io', repo: parts.length === 1 ? `library/${rest}` : rest, tag };
}

const tokens = new Map();
async function registryGet(host, repo, reference) {
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https';
  const url = `${scheme}://${host}/v2/${repo}/manifests/${reference}`;
  const headers = () => ({ Accept: ACCEPT, ...(tokens.has(`${host}/${repo}`) ? { Authorization: `Bearer ${tokens.get(`${host}/${repo}`)}` } : {}) });
  let res = await fetch(url, { headers: headers() });
  if (res.status === 401) {
    const ch = res.headers.get('www-authenticate') ?? '';
    const p = Object.fromEntries([...ch.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const q = new URLSearchParams({ ...(p.service ? { service: p.service } : {}), scope: p.scope ?? `repository:${repo}:pull` });
    const t = await (await fetch(`${p.realm}?${q}`)).json();
    tokens.set(`${host}/${repo}`, t.token ?? t.access_token);
    res = await fetch(url, { headers: headers() });
  }
  if (res.status !== 200) throw new Error(`${host}/${repo}:${reference}: the registry answered ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  return { digest: res.headers.get('docker-content-digest') ?? `sha256:${sha256(body)}`, json: JSON.parse(body.toString('utf8')), body };
}

async function blobJson(host, repo, digest) {
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https';
  const t = tokens.get(`${host}/${repo}`);
  const res = await fetch(`${scheme}://${host}/v2/${repo}/blobs/${digest}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (res.status !== 200) throw new Error(`${host}/${repo}@${digest}: blob answered ${res.status}`);
  return res.json();
}

/** The index digest and one manifest digest per linux platform. */
async function resolveImage(ref) {
  const { host, repo, tag } = parseRef(ref);
  const top = await registryGet(host, repo, tag);
  const platforms = {};
  if (Array.isArray(top.json.manifests)) {
    for (const m of top.json.manifests) {
      const p = m.platform;
      if (!p || p.os !== 'linux' || p.architecture === 'unknown') continue;
      if (p.architecture === 'arm' || (p.variant && p.architecture !== 'arm64')) continue;
      platforms[`linux/${p.architecture}`] ??= m.digest;
    }
    return { index: top.digest, platforms };
  }
  const config = await blobJson(host, repo, top.json.config.digest);
  platforms[`linux/${config.architecture}`] = top.digest;
  return { index: null, platforms };
}

// -- the manifest ----------------------------------------------------------------

const images = {};
const services = composeServices();
for (const [service, svc] of Object.entries(services)) {
  const ref = svc.image.replace(/@sha256:[0-9a-f]+$/, '');
  const key = imageKey(ref, service);
  images[key] ??= { ref, env: envKeyOf(key), index: null, platforms: {}, services: [] };
  images[key].services.push(service);
}
for (const [key, img] of Object.entries(catalogue.images ?? {})) images[key] = { ref: img.ref, env: null, index: null, platforms: {}, services: [] };
for (const [key, img] of Object.entries(images)) {
  const r = await resolveImage(img.ref);
  if (Object.keys(r.platforms).length === 0) throw new Error(`${img.ref} has no linux image`);
  img.index = r.index;
  img.platforms = r.platforms;
  console.error(`${key}: ${img.ref} ${Object.entries(r.platforms).map(([p, d]) => `${p}=${d.slice(0, 19)}`).join(' ')}`);
}

const files = {};
for (const f of ['install-tagave.sh', 'deploy/compose.yml', 'deploy/compose.db-published.yml']) files[f.replace(/^deploy\//, '')] = sha256(readFileSync(join(repo, f)));

const manifest = {
  schema: 1,
  project: 'tagave',
  version,
  publishedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  commit,
  images,
  modules: catalogue.modules,
  files,
};
const text = `${JSON.stringify(manifest, null, 2)}\n`;
parseManifest(text);

// --key-file: a key on disk, for a local test release; CI uses the environment.
const keyFile = opt('key-file');
const pem = keyFile ? readFileSync(resolve(keyFile), 'utf8') : process.env[keyEnv];
if (!pem) {
  console.error(`${keyEnv} is not set: the release cannot be signed (docs/security.md, "Signed releases", says how the key is set up)`);
  process.exit(1);
}
const key = createPrivateKey(pem);
const signature = signManifest(text, key);
const keys = await loadTrustedKeys(keysDir);
verifyRelease(text, signature, keys, { version });

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'release-manifest.json'), text);
writeFileSync(join(out, 'release-manifest.json.sig'), signature);
const installer = readFileSync(join(repo, 'install-tagave.sh'));
writeFileSync(join(out, 'install-tagave.sh.sig'), signManifest(installer, key));
writeFileSync(join(out, 'install-tagave.sh.sha256'), `${sha256(installer)}  install-tagave.sh\n`);
console.log(JSON.stringify({ version, images: Object.fromEntries(Object.entries(images).map(([k, v]) => [k, v.index ?? Object.values(v.platforms)[0]])) }));
