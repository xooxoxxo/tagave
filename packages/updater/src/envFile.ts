/**
 * The install's .env, read and rewritten the way install-tagave.sh does:
 * KEY=value lines, one pair of surrounding quotes stripped, every other line
 * (comments, order, secrets) kept byte for byte.
 */
import { readFile } from 'node:fs/promises';
import { writeFileKeepingOwner } from './safe-write.js';

export function envGet(text: string, key: string): string | null {
  let value: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${key}=`)) continue;
    value = line.slice(key.length + 1).replace(/\r$/, '');
  }
  if (value === null) return null;
  const m = /^'(.*)'$/.exec(value) ?? /^"(.*)"$/.exec(value);
  return m ? m[1]! : value;
}

/**
 * Replaces the last KEY= line (or appends one). Values are written bare, so
 * only characters that need no quoting are taken: a version, a digest
 * (sha256:…), a URL, a profile list; empty clears the setting.
 */
export function envSet(text: string, key: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`refusing to write the setting ${key}: not a name`);
  if (!/^[A-Za-z0-9._:/@,-]*$/.test(value)) throw new Error(`refusing to write ${key}: unexpected characters in its value`);
  const lines = text.split('\n');
  let idx = -1;
  lines.forEach((line, i) => { if (line.startsWith(`${key}=`)) idx = i; });
  if (idx >= 0) {
    lines[idx] = `${key}=${value}`;
    return lines.join('\n');
  }
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${key}=${value}\n`;
}

/** Drops every KEY= line. */
export function envUnset(text: string, key: string): string {
  return text.split('\n').filter((line) => !line.startsWith(`${key}=`)).join('\n');
}

/** Every KEY of `text` whose name matches `re`. */
export function envKeys(text: string, re: RegExp): string[] {
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const k = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
    if (k && re.test(k)) keys.add(k);
  }
  return [...keys];
}

/**
 * Writes `content` to `path` atomically (safe-write.ts: owner, group and mode
 * of the file it replaces). The original is first copied to `path.bak`, with
 * the original's owner and mode. A new file is 600: .env holds the secrets.
 */
export async function writeFileAtomic(path: string, content: string, keepBackup = true): Promise<void> {
  if (keepBackup) {
    const original = await readText(path);
    if (original !== null) await writeFileKeepingOwner(`${path}.bak`, original, { ownerFrom: path });
  }
  await writeFileKeepingOwner(path, content, { fallbackMode: 0o600 });
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The name a pre-0.9 LINER_* setting has now (the project was called liner).
 * TAGAVE_VERSION is the image tag, so the build's version is
 * TAGAVE_BUILD_VERSION; LINER_BACKUP_DIR was the app's folder inside its
 * container, BACKUP_DIR now (TAGAVE_BACKUP_DIR is the host folder).
 * Same rules as legacy_env_target in install-tagave.sh. Drop in 0.10.
 */
export function legacyEnvTarget(key: string): string {
  if (key === 'LINER_VERSION') return 'TAGAVE_BUILD_VERSION';
  if (key === 'LINER_BACKUP_DIR') return 'BACKUP_DIR';
  return `TAGAVE_${key.slice('LINER_'.length)}`;
}

export interface LegacyEnvMigration {
  text: string;
  /** "LINER_X->TAGAVE_X", or "LINER_X (dropped: TAGAVE_X is set)". Names only, never values. */
  notes: string[];
}

/**
 * Renames every LINER_* key to its new name, keeping its value; when the new
 * name is already set it wins and the old line goes. Every other line stays
 * byte for byte.
 */
export function migrateLegacyEnv(text: string): LegacyEnvMigration {
  const lines = text.split('\n');
  const keyOf = (line: string) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1] ?? null;
  const present = new Set(lines.map(keyOf).filter((k): k is string => k !== null));
  const notes = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = keyOf(line);
    if (key === null || !/^LINER_[A-Z0-9_]+$/.test(key)) {
      out.push(line);
      continue;
    }
    const target = legacyEnvTarget(key);
    if (present.has(target)) {
      notes.add(`${key} (dropped: ${target} is set)`);
      continue;
    }
    notes.add(`${key}->${target}`);
    out.push(`${target}${line.slice(key.length)}`);
  }
  return { text: out.join('\n'), notes: [...notes] };
}
