/**
 * Environment variables. They are named TAGAVE_*; releases before 0.9 named
 * them LINER_* (the project's old name). Until 0.10 every reader takes the
 * new name first and falls back to the old one, logging once per process
 * that the old name is deprecated. 0.10 drops the fallback
 * (LEGACY_ENV_NAMES and readRenamedEnv's legacy branch).
 */

type Env = Record<string, string | undefined>;
export type EnvWarn = (message: string) => void;

/** New suffix -> the name older releases used, where it is not simply LINER_<suffix>. */
const LEGACY_NAMES: Record<string, string> = {
  // TAGAVE_VERSION already means the image tag in an installer's .env, so the
  // version a build reports is TAGAVE_BUILD_VERSION (formerly LINER_VERSION).
  BUILD_VERSION: 'LINER_VERSION',
};

/** The old name of TAGAVE_<suffix>. */
export function legacyEnvName(suffix: string): string {
  return LEGACY_NAMES[suffix] ?? `LINER_${suffix}`;
}

const warned = new Set<string>();

function processEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

const consoleWarn: EnvWarn = (message) => (globalThis as { console?: { warn: (m: string) => void } }).console?.warn(message);

/**
 * The value of `name`, or of `legacyName` when only the old name is set
 * (non-empty), with a one-time deprecation warning. An empty new name counts
 * as unset, so a compose file that passes `TAGAVE_X: ${TAGAVE_X:-}` does not
 * hide an old LINER_X set elsewhere.
 */
export function readRenamedEnv(
  name: string,
  legacyName: string,
  env: Env = processEnv(),
  warn: EnvWarn = consoleWarn,
): string | undefined {
  const current = env[name];
  if (current !== undefined && current !== '') return current;
  const legacy = env[legacyName];
  if (legacy !== undefined && legacy !== '') {
    if (!warned.has(legacyName)) {
      warned.add(legacyName);
      warn(`${legacyName} is deprecated: rename it to ${name}. The old name stops working in tagave 0.10.`);
    }
    return legacy;
  }
  return current;
}

/** TAGAVE_<suffix>, falling back to its pre-0.9 name (see readRenamedEnv). */
export function tagaveEnv(suffix: string, env: Env = processEnv(), warn: EnvWarn = consoleWarn): string | undefined {
  return readRenamedEnv(`TAGAVE_${suffix}`, legacyEnvName(suffix), env, warn);
}

/** Tests only: warn again for names already warned about. */
export function resetEnvWarnings(): void {
  warned.clear();
}
