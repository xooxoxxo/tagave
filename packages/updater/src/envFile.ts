/**
 * The install's .env, read and rewritten the way install-tagave.sh does:
 * KEY=value lines, one pair of surrounding quotes stripped, every other line
 * (comments, order, secrets) kept byte for byte.
 */
import { chmod, copyFile, open, readFile, rename, stat } from 'node:fs/promises';

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

/** Replaces the last KEY= line (or appends one). */
export function envSet(text: string, key: string, value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`refusing to write ${key}=${value}: unexpected characters`);
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

/**
 * Writes `content` to `path` atomically: a private temp file next to it,
 * fsynced, then renamed over the original. The original is first copied to
 * `path.bak` (same mode). The file keeps its mode (600 for .env).
 */
export async function writeFileAtomic(path: string, content: string, keepBackup = true): Promise<void> {
  let mode = 0o600;
  try {
    mode = (await stat(path)).mode & 0o777;
    if (keepBackup) {
      await copyFile(path, `${path}.bak`);
      await chmod(`${path}.bak`, mode);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = `${path}.tmp.${process.pid}`;
  const fh = await open(tmp, 'w', mode);
  try {
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await chmod(tmp, mode);
  await rename(tmp, path);
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
