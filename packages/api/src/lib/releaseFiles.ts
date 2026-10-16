/**
 * The signed files of a release (release-manifest.json and its signature),
 * downloaded from where the release publishes them. The app only carries
 * them to the updater: the updater checks the signature with the keys in
 * its own image, so a download that was tampered with on the way is
 * refused there. Installs without the updater check it here, with the
 * same keys copied into the app image, before they list any module.
 *
 * TAGAVE_RELEASE_ASSETS_URL replaces the official location
 * (https://github.com/xooxoxxo/tagave/releases/download); files are read
 * from <base>/v<version>/<file>.
 */
import { DEFAULT_RELEASE_ASSETS_URL, MANIFEST_FILE, MANIFEST_SIGNATURE_FILE } from '@tagave/shared';
import { loadTrustedKeys, MAX_MANIFEST_BYTES, type TrustedKey } from '@tagave/updater/release';

const TIMEOUT_MS = 10_000;
const cache = new Map<string, { manifest: string; signature: string; at: number }>();
const CACHE_MS = 10 * 60_000;

export class ReleaseFilesError extends Error {}

export function releaseAssetsBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['TAGAVE_RELEASE_ASSETS_URL']?.trim() || DEFAULT_RELEASE_ASSETS_URL).replace(/\/$/, '');
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { 'user-agent': 'tagave-release-check' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ReleaseFilesError(`${url} did not answer (${(err as Error).message})`);
  }
  if (res.status === 404) throw new ReleaseFilesError(`${url} does not exist: this release publishes no signed manifest`);
  if (!res.ok) throw new ReleaseFilesError(`${url} answered ${res.status}`);
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new ReleaseFilesError(`${url} is too large to be a release manifest`);
  return text;
}

/** The manifest and its signature for `version`, unverified (the updater verifies). */
export async function fetchReleaseFiles(version: string, fetchImpl: typeof fetch = fetch): Promise<{ manifest: string; signature: string }> {
  const hit = cache.get(version);
  if (hit && Date.now() - hit.at < CACHE_MS) return { manifest: hit.manifest, signature: hit.signature };
  const base = `${releaseAssetsBase()}/v${encodeURIComponent(version)}`;
  const [manifest, signature] = await Promise.all([fetchText(`${base}/${MANIFEST_FILE}`, fetchImpl), fetchText(`${base}/${MANIFEST_SIGNATURE_FILE}`, fetchImpl)]);
  cache.set(version, { manifest, signature, at: Date.now() });
  return { manifest, signature };
}

export function clearReleaseFilesCache(): void {
  cache.clear();
}

let keys: Promise<TrustedKey[]> | null = null;

/** The public release keys copied into the app image (TAGAVE_RELEASE_KEYS_DIR in development). */
export function appReleaseKeys(): Promise<TrustedKey[]> {
  keys ??= loadTrustedKeys(process.env['TAGAVE_RELEASE_KEYS_DIR'] || '/opt/tagave/release-keys');
  return keys;
}
