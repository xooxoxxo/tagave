/**
 * Test-only: the argv allowlist every fake Docker in the updater tests runs
 * before it answers. It fails on the commands the updater must never send:
 * any `prune`, `docker system`, `volume rm`, `compose down`, `rm` with
 * `-v`/`--volumes`, any unmount (`umount` or stopping a `.mount` unit, also
 * inside a helper's nsenter command or a `sh -c` string), and a `ps` filter
 * that is not scoped to the compose project label or the hand-over label.
 *
 * The updater often turns a failed docker call into a result instead of a
 * throw, so a throw alone could be swallowed. Every violation is also kept,
 * and an afterEach in the importing test file fails the test that caused it.
 */
import { afterEach } from 'vitest';

export interface GuardOptions {
  /** Only for the module tests where the owner chose to delete the module's data. */
  allowVolumeRm?: boolean;
}

const PROJECT_FILTER = 'label=com.docker.compose.project=';
const HANDOVER_FILTER = 'label=tagave.updater.handover';
const UNIT_STOPS = new Set(['stop', 'restart', 'try-restart', 'reload-or-restart', 'kill']);

const violations: string[][] = [];

/** Each argv element split into shell words, so `sh -c '...'` strings are read too. */
const wordsOf = (argv: string[]) => argv.flatMap((a) => a.split(/[\s;&|()]+/)).filter((w) => w !== '');

const isRemoveFlag = (w: string) => w === '--volumes' || /^-[a-z]*v[a-z]*$/.test(w);

function filtersOf(argv: string[]): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if ((a === '--filter' || a === '-f') && argv[i + 1] !== undefined) out.push(argv[i + 1]!);
    else if (a.startsWith('--filter=')) out.push(a.slice('--filter='.length));
  });
  return out;
}

const scoped = (f: string) =>
  (f.startsWith(PROJECT_FILTER) && f.length > PROJECT_FILTER.length) || f === HANDOVER_FILTER || f.startsWith(`${HANDOVER_FILTER}=`);

function reason(argv: string[], opts: GuardOptions): string | null {
  const words = wordsOf(argv);
  if (words.includes('prune')) return 'prune';
  if (argv[0] === 'system' || words.some((w, i) => w === 'system' && words[i - 1] === 'docker')) return 'docker system';
  if (words.some((w, i) => (w === 'rm' || w === 'remove') && words[i - 1] === 'volume') && !opts.allowVolumeRm) return 'volume rm';
  const compose = words.indexOf('compose');
  if (compose >= 0 && words.slice(compose + 1).includes('down')) return 'compose down';
  const rm = words.findIndex((w) => w === 'rm');
  if (rm >= 0 && words.slice(rm + 1).some(isRemoveFlag)) return 'rm with -v';
  if (words.some((w) => w === 'umount' || w.endsWith('/umount'))) return 'umount';
  if (words.some((w, i) => w === 'systemctl' && UNIT_STOPS.has(words[i + 1] ?? '') && words.slice(i + 2).some((u) => u.endsWith('.mount')))) return 'unmount';
  const ps = argv[0] === 'ps' || (argv[0] === 'container' && ['ps', 'ls', 'list'].includes(argv[1] ?? ''));
  if (ps) {
    const filters = filtersOf(argv);
    if (filters.length > 0 && !filters.some(scoped)) return 'ps filter without the project label';
  }
  return null;
}

/** Throws, and records, when `argv` is a docker command the updater must never send. */
export function assertAllowed(argv: string[], opts: GuardOptions = {}): void {
  const why = reason(argv, opts);
  if (why === null) return;
  violations.push([...argv]);
  throw new Error(`argv not allowed (${why}): docker ${argv.join(' ')}`);
}

/** The violations recorded since the last call, cleared. */
export function takeViolations(): string[][] {
  return violations.splice(0);
}

afterEach(() => {
  const seen = takeViolations();
  if (seen.length > 0) throw new Error(`forbidden docker argv sent:\n${seen.map((a) => `  docker ${a.join(' ')}`).join('\n')}`);
});
