#!/usr/bin/env node
/**
 * Release notes from conventional commits, as a DRAFT for a human to finish.
 *
 *   node scripts/release-notes.mjs --version X.Y.Z [--from <tag>] [--to <ref>] [--out file]
 *   node scripts/release-notes.mjs --changelog [--dir release-notes] [--out CHANGELOG.md]
 *   node scripts/release-notes.mjs --check release-notes/vX.Y.Z.md
 *
 * The draft follows release-notes/v0.9.0.md: a bold first line with the
 * release type and a one-sentence summary (left as "TODO: summary"), then
 * Before you update, New, Improved, Fixed, For self-hosters and the compare
 * link. Every bullet links its commit. It is marked with DRAFT_MARKER so CI
 * and scripts/release.sh refuse to ship it unedited.
 *
 * Commits are read as `type(scope)!: subject` with body and footers. Two
 * footers matter: `BREAKING CHANGE: <text>` and `Requires-Attention: <text>`;
 * either one makes the draft carry a "**Requires attention:**" line, which the
 * app's updater (packages/api/src/lib/updatesFeed.ts) turns into a "I have
 * read the notes" checkbox.
 *
 * --from defaults to the newest stable tag older than --version; --to to HEAD.
 * The script exits non-zero when --version bumps less than the commits need
 * (pre-1.0: a breaking change or a feature needs a minor bump; from 1.0 on
 * normal semver). --allow-under-bump turns that into a warning, for drafting
 * notes of releases that were already tagged; release.sh and CI never pass it.
 *
 * git is run through child_process with explicit arguments; the number of
 * commits parsed is checked against `git rev-list --count`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DRAFT_MARKER = '<!-- draft: edit before release -->';
export const REPO_URL = 'https://github.com/xooxoxxo/tagave';
const MIGRATIONS_DIR = 'packages/db/migrations';
const ENV_FILES = ['.env.example', 'deploy/compose.yml'];
const RELEASE_KEYS_DIR = 'deploy/release-keys';

/** Scopes whose commits concern whoever runs the server, not the app's users. */
export const SELF_HOSTER_SCOPES = new Set(['deploy', 'installer', 'install', 'doctor', 'updater', 'ops', 'operations', 'backup', 'backups']);
/** docs scopes that are instructions for self-hosters. */
const SELF_HOSTER_DOC_SCOPES = new Set(['install', 'installer', 'operations', 'ops', 'deploy', 'security', 'upgrade', 'updater']);
/** refactor scopes a user can notice (layout, wording, behaviour of the app). */
const USER_VISIBLE_REFACTOR_SCOPES = new Set(['web', 'ui', 'player', 'api']);
const SKIPPED_TYPES = new Set(['ci', 'test', 'tests', 'chore', 'docs', 'build', 'style', 'revert']);

// -- versions ---------------------------------------------------------------------

/** "v0.8.0" / "0.8.0-rc.1" → { major, minor, patch, pre } or null. */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

export function formatVersion(v) {
  return `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ''}`;
}

/** Compares the X.Y.Z part only. */
export function compareBase(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** Full semver order (a prerelease sorts before its release). */
export function compareVersions(a, b) {
  const base = compareBase(a, b);
  if (base) return base;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

/** The kind of bump from → to (X.Y.Z parts only): major, minor, patch or none. */
export function bumpKind(from, to) {
  if (to.major !== from.major) return to.major > from.major ? 'major' : 'none';
  if (to.minor !== from.minor) return to.minor > from.minor ? 'minor' : 'none';
  if (to.patch !== from.patch) return to.patch > from.patch ? 'patch' : 'none';
  return 'none';
}

/**
 * The smallest bump the commits need. Pre-1.0 a breaking change is a minor
 * bump; from 1.0 on it is a major one. A feature is a minor bump, anything
 * else a patch.
 */
export function requiredBump(commits, from) {
  const breaking = commits.some((c) => c.breaking);
  const feature = commits.some((c) => c.type === 'feat');
  if (breaking) return from.major >= 1 ? 'major' : 'minor';
  if (feature) return 'minor';
  return 'patch';
}

/** Throws with a clear message when `to` bumps less than the commits need. */
export function checkBump(commits, from, to) {
  const actual = bumpKind(from, to);
  if (actual === 'none') {
    throw new Error(`release-notes: ${formatVersion(to)} is not newer than ${formatVersion(from)}`);
  }
  const need = requiredBump(commits, from);
  if (RANK[actual] < RANK[need]) {
    const anyBreaking = commits.some((c) => c.breaking);
    const why = commits.filter((c) => (anyBreaking ? c.breaking : c.type === 'feat'));
    const examples = why.slice(0, 3).map((c) => `  ${c.short} ${c.subjectLine}`).join('\n');
    const suggest = need === 'major'
      ? `${from.major + 1}.0.0`
      : need === 'minor' ? `${from.major}.${from.minor + 1}.0` : `${from.major}.${from.minor}.${from.patch + 1}`;
    const reason = anyBreaking ? 'a breaking change' : 'new features';
    throw new Error(
      `release-notes: ${formatVersion(from)} → ${formatVersion(to)} is a ${actual} bump, but the commits include ${reason}, ` +
      `which needs a ${need} bump${from.major < 1 && need === 'minor' ? ' before 1.0' : ''}.\n${examples}\n  use --version ${suggest} (or higher)`,
    );
  }
  return actual;
}

/** "Minor release (0.8 → 0.9)", "Patch release (0.7.6 → 0.7.7)". */
export function releaseLabel(kind, from, to) {
  const name = { major: 'Major', minor: 'Minor', patch: 'Patch' }[kind] ?? 'New';
  const short = (v) => (kind === 'patch' ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}`);
  const pre = to.pre ? `, pre-release ${formatVersion(to)}` : '';
  return `${name} release (${short(from)} → ${short(to)}${pre})`;
}

// -- commits ------------------------------------------------------------------------

const HEADER = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
const FOOTER_TOKEN = /^(BREAKING[ -]CHANGE|[A-Za-z][A-Za-z0-9-]*):\s?(.*)$/;
/** Trailer-style keys (Requires-Attention, Co-Authored-By) and BREAKING CHANGE; not "Note:" prose. */
const isFooterKey = (key) => key.startsWith('BREAKING') || key.includes('-') || /^(Refs|Closes|Fixes)$/i.test(key);

/**
 * Footers of a commit body: `Token: value` lines, a value continuing over the
 * following lines until a blank line or the next footer. Returns
 * [{ key, value }] in order.
 */
export function parseFooters(body) {
  const footers = [];
  let current = null;
  for (const line of String(body ?? '').split('\n')) {
    const m = FOOTER_TOKEN.exec(line);
    if (m && isFooterKey(m[1])) {
      current = { key: m[1], value: m[2].trim() };
      footers.push(current);
    } else if (current && line.trim() !== '') {
      current.value = `${current.value} ${line.trim()}`.trim();
    } else {
      current = null;
    }
  }
  return footers;
}

/** One commit from git: { sha, short, subject, body } → classified record. */
export function parseCommit({ sha, short, subject, body }) {
  const m = HEADER.exec(subject.trim());
  const footers = parseFooters(body);
  const breakingNotes = footers.filter((f) => /^BREAKING[ -]CHANGE$/.test(f.key)).map((f) => f.value).filter(Boolean);
  const attention = footers.filter((f) => /^requires-attention$/i.test(f.key)).map((f) => f.value).filter(Boolean);
  const base = { sha, short, subjectLine: subject.trim(), body: body ?? '', breakingNotes, attention };
  if (!m) return { ...base, type: null, scope: null, subject: subject.trim(), breaking: breakingNotes.length > 0 };
  return {
    ...base,
    type: m[1].toLowerCase(),
    scope: m[2] ? m[2].trim().toLowerCase() : null,
    subject: m[4].trim(),
    breaking: Boolean(m[3]) || breakingNotes.length > 0,
  };
}

/**
 * Which section a commit goes to: new, improved, fixed, selfHosters,
 * unsorted (not a conventional commit), or null (left out).
 */
export function classify(c) {
  if (!c.type) return 'unsorted';
  const scopes = (c.scope ?? '').split(/[,/ ]+/).filter(Boolean);
  const selfHosterScope = scopes.some((s) => SELF_HOSTER_SCOPES.has(s));
  switch (c.type) {
    case 'feat':
      return selfHosterScope ? 'selfHosters' : 'new';
    case 'fix':
      return 'fixed';
    case 'perf':
      return selfHosterScope ? 'selfHosters' : 'improved';
    case 'refactor':
      if (selfHosterScope) return 'selfHosters';
      return scopes.some((s) => USER_VISIBLE_REFACTOR_SCOPES.has(s)) ? 'improved' : null;
    case 'ops':
      return 'selfHosters';
    case 'docs':
      return scopes.some((s) => SELF_HOSTER_DOC_SCOPES.has(s)) ? 'selfHosters' : null;
    default:
      return SKIPPED_TYPES.has(c.type) ? null : 'unsorted';
  }
}

// -- env keys, migrations ------------------------------------------------------------

/** Keys a file names: `KEY=` lines (commented or not) and `${KEY` references. */
export function envKeys(text) {
  const keys = new Set();
  if (!text) return keys;
  for (const m of text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*[A-Z0-9])=/gm)) keys.add(m[1]);
  for (const m of text.matchAll(/\$\{([A-Z][A-Z0-9_]*[A-Z0-9])/g)) keys.add(m[1]);
  return keys;
}

/**
 * Added / removed / renamed keys between two versions of a file. A rename is
 * a removed and an added key that differ only in their first segment
 * (LINER_PORT → TAGAVE_PORT), or that share the same tail.
 */
export function diffKeys(before, after) {
  const added = [...after].filter((k) => !before.has(k)).sort();
  const removed = [...before].filter((k) => !after.has(k)).sort();
  const renamed = [];
  const tail = (k) => k.replace(/^[A-Z0-9]+_/, '');
  for (const r of [...removed]) {
    const match = added.find((a) => tail(a) === tail(r) && tail(r) !== r);
    if (match) {
      renamed.push([r, match]);
      removed.splice(removed.indexOf(r), 1);
      added.splice(added.indexOf(match), 1);
    }
  }
  return { added, removed, renamed };
}

/** "0042–0045" for a run of numbered migrations, else a comma list. */
export function migrationRange(files) {
  const nums = files.map((f) => /(\d+)[^/]*$/.exec(f.split('/').at(-1))?.[1]).filter(Boolean).sort();
  if (!nums.length) return '';
  if (nums.length === 1) return `migration ${nums[0]}`;
  const ints = nums.map(Number);
  const consecutive = ints.every((n, i) => i === 0 || n === ints[i - 1] + 1);
  return consecutive ? `migrations ${nums[0]}–${nums.at(-1)}` : `migrations ${nums.join(', ')}`;
}

/** "0046_cover_thumbs.sql" → "0046 cover thumbs". */
const migrationTitle = (file) => file.split('/').at(-1).replace(/\.sql$/, '').replace(/^(\d+)_/, '$1 ').replace(/_/g, ' ');

// -- git -------------------------------------------------------------------------------

export function makeGit(cwd) {
  const bin = process.env.RELEASE_NOTES_GIT || 'git';
  return (...args) => execFileSync(bin, ['--no-pager', '-c', 'core.quotepath=off', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function showFile(git, ref, path) {
  try {
    return git('show', `${ref}:${path}`);
  } catch {
    return null; // not in that ref
  }
}

/** Commits from..to, oldest first, merges left out, checked against rev-list --count. */
export function readCommits(git, from, to) {
  const range = `${from}..${to}`;
  const raw = git('log', '--no-merges', '--no-color', '--abbrev=7', '--format=%H%x1f%h%x1f%s%x1f%b%x1e', range);
  const records = raw.split('\x1e').map((r) => r.replace(/^\n+/, '')).filter((r) => r.trim() !== '');
  const commits = records.map((r) => {
    const [sha, short, subject, body = ''] = r.split('\x1f');
    if (!sha || !short || subject === undefined) throw new Error(`release-notes: unreadable git log record: ${JSON.stringify(r.slice(0, 120))}`);
    return parseCommit({ sha: sha.trim(), short: short.trim(), subject, body: body.trim() });
  });
  const expected = Number(git('rev-list', '--count', '--no-merges', range).trim());
  if (!Number.isInteger(expected) || expected !== commits.length) {
    throw new Error(`release-notes: parsed ${commits.length} commits in ${range}, git rev-list --count says ${expected}`);
  }
  return commits.reverse(); // oldest first, the order they were made in
}

/** The newest stable v* tag older than `version`. */
export function previousTag(git, version) {
  const tags = git('tag', '--list', 'v*').split('\n').map((t) => t.trim()).filter(Boolean);
  const older = tags
    .map((t) => ({ t, v: parseVersion(t) }))
    .filter(({ v }) => v && !v.pre && compareBase(v, version) < 0)
    .sort((a, b) => compareVersions(b.v, a.v));
  return older[0]?.t ?? null;
}

/** What changed for whoever runs the server, read from the trees. */
export function readTreeChanges(git, from, to) {
  const names = (filter, path) => git('diff', '--name-only', `--diff-filter=${filter}`, from, to, '--', path)
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const migrations = names('A', MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const env = ENV_FILES.map((file) => ({ file, ...diffKeys(envKeys(showFile(git, from, file)), envKeys(showFile(git, to, file))) }));
  const keysAdded = names('A', RELEASE_KEYS_DIR);
  const keysRemoved = names('D', RELEASE_KEYS_DIR);
  return { migrations, env, keysAdded, keysRemoved };
}

// -- the draft --------------------------------------------------------------------------

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const link = (c, repoUrl) => `[${c.short}](${repoUrl}/commit/${c.short})`;
const bullet = (c, repoUrl) => `- ${c.scope ? `**${c.scope}:** ` : ''}${capitalize(c.subject)} (${link(c, repoUrl)})`;
/** Scoped commits by scope name, unscoped ones last. */
const byScope = (a, b) => (a.scope === null) - (b.scope === null) || (a.scope ?? '').localeCompare(b.scope ?? '');
const codeList = (keys) => keys.map((k) => `\`${k}\``).join(', ');

/**
 * The draft text. `commits` are parsed commits, `tree` the readTreeChanges
 * result; from/to are parsed versions, fromTag the tag compared against.
 */
export function renderDraft({ commits, tree, from, to, fromTag, kind, repoUrl = REPO_URL }) {
  const out = [DRAFT_MARKER, `**${releaseLabel(kind, from, to)}.** TODO: summary`, ''];
  const sections = { new: [], improved: [], fixed: [], selfHosters: [], unsorted: [] };
  for (const c of commits) {
    const where = classify(c);
    if (where) sections[where].push(c);
  }

  // Before you update
  const before = [];
  const attention = commits.flatMap((c) => c.attention.map((text) => ({ c, text })));
  const breaking = commits.filter((c) => c.breaking);
  if (attention.length || breaking.length) {
    const what = [...attention.map((a) => a.text), ...breaking.map((c) => c.breakingNotes[0] ?? capitalize(c.subject))];
    before.push(`**Requires attention:** ${what.join(' ')}`, '');
  }
  for (const c of breaking) {
    const notes = c.breakingNotes.length ? c.breakingNotes.join(' ') : 'TODO: say what changes and what to do.';
    before.push(`- **Breaking: ${capitalize(c.subject)}.** ${notes} (${link(c, repoUrl)})`);
  }
  for (const { c, text } of attention) before.push(`- **${text}** (${link(c, repoUrl)})`);
  const prev = kind === 'patch' ? formatVersion({ ...from, pre: null }) : `${from.major}.${from.minor}`;
  if (tree.migrations.length) {
    before.push(`- **Going back to ${prev} means a restore.** This update changes the database (${migrationRange(tree.migrations)}). ` +
      `The updater takes a backup first and restores it on its own if the update fails; to return to ${prev} later, follow ` +
      `[Going back](${repoUrl}/blob/v${formatVersion(to)}/docs/operations.md).`);
  }
  for (const e of tree.env) {
    const parts = [];
    if (e.added.length) parts.push(`added ${codeList(e.added)}`);
    if (e.removed.length) parts.push(`removed ${codeList(e.removed)}`);
    if (e.renamed.length) parts.push(`renamed ${e.renamed.map(([a, b]) => `\`${a}\` → \`${b}\``).join(', ')}`);
    if (parts.length) before.push(`- **Settings in \`${e.file}\`:** ${parts.join('; ')}.`);
  }
  if (!before.length) before.push('- Nothing to do before this update.');
  out.push('## Before you update', '', ...before, '');

  const section = (title, list) => {
    if (!list.length) return;
    out.push(`## ${title}`, '', ...[...list].sort(byScope).map((c) => bullet(c, repoUrl)), '');
  };
  section('New', sections.new);
  section('Improved', sections.improved);
  section('Fixed', sections.fixed);

  const self = [];
  if (tree.migrations.length) self.push(`- **Migrations:** ${tree.migrations.map(migrationTitle).join(', ')}.`);
  const digests = tree.env.flatMap((e) => [...e.added, ...e.removed, ...e.renamed.flat()]).filter((k) => k.startsWith('TAGAVE_DIGEST_'));
  if (digests.length) self.push(`- **Image digests:** ${codeList([...new Set(digests)])} changed in \`compose.yml\` / \`.env\`.`);
  if (tree.keysAdded.length) self.push(`- **Release keys added:** ${codeList(tree.keysAdded)}.`);
  if (tree.keysRemoved.length) self.push(`- **Release keys removed:** ${codeList(tree.keysRemoved)}.`);
  self.push(...[...sections.selfHosters].sort(byScope).map((c) => bullet(c, repoUrl)));
  if (self.length) out.push('## For self-hosters', '', ...self, '');

  if (sections.unsorted.length) {
    out.push('## Unsorted', '', 'TODO: these commits are not conventional commits; move each one to a section above or delete it.', '',
      ...sections.unsorted.map((c) => `- ${c.subjectLine} (${link(c, repoUrl)})`), '');
  }

  out.push(`**All changes:** [${fromTag}...v${formatVersion(to)}](${repoUrl}/compare/${fromTag}...v${formatVersion(to)})`, '');
  return out.join('\n');
}

/** Problems that make a notes file unfit to ship: missing, draft marker, TODO. */
export function notesProblems(text) {
  if (text === null || text === undefined) return ['the notes file is missing'];
  const problems = [];
  if (text.includes(DRAFT_MARKER) || /<!--\s*draft:/i.test(text)) problems.push(`it still has the draft marker (${DRAFT_MARKER})`);
  if (/TODO:/.test(text)) problems.push('it still has a TODO: placeholder');
  if (!text.trim()) problems.push('it is empty');
  return problems;
}

// -- CHANGELOG.md -------------------------------------------------------------------------

/** CHANGELOG.md text from { version, text, date } entries, newest first. */
export function renderChangelog(entries, repoUrl = REPO_URL) {
  const sorted = [...entries].sort((a, b) => compareVersions(parseVersion(b.version), parseVersion(a.version)));
  const out = [
    '# Changelog',
    '',
    `Every release of tagave, newest first. Assembled from [\`release-notes/\`](release-notes/) by \`node scripts/release-notes.mjs --changelog\`; edit the notes there, not here.`,
    '',
  ];
  for (const e of sorted) {
    const draft = e.text.includes(DRAFT_MARKER);
    const body = e.text
      .replace(DRAFT_MARKER, '')
      .replace(/ ?TODO: summary/, '')
      .replace(/^(#{2,5}) /gm, '#$1 ')
      .trim();
    out.push(`## [v${e.version}](${repoUrl}/releases/tag/v${e.version})${e.date ? ` (${e.date})` : ''}`, '');
    if (draft) out.push('_Generated from the commits; not edited by hand._', '');
    out.push(body, '');
  }
  return out.join('\n');
}

function readNotesDir(dir, git) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.md$/.exec(f))
    .filter(Boolean)
    .map((m) => {
      let date = null;
      try {
        date = git('log', '-1', '--format=%as', `refs/tags/v${m[1]}`).trim() || null;
      } catch { /* not tagged yet */ }
      return { version: m[1], text: readFileSync(join(dir, m[0]), 'utf8'), date };
    });
}

// -- CLI ----------------------------------------------------------------------------------

export function main(argv, { cwd = process.cwd(), stdout = process.stdout } = {}) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flag = (name) => argv.includes(`--${name}`);
  const git = makeGit(cwd);
  const repoUrl = opt('repo-url') ?? REPO_URL;
  const emit = (text, out) => {
    if (out) writeFileSync(resolve(cwd, out), text);
    else stdout.write(text);
  };

  if (flag('check')) {
    const file = opt('check');
    const path = file ? resolve(cwd, file) : null;
    const problems = notesProblems(path && existsSync(path) ? readFileSync(path, 'utf8') : null);
    if (problems.length) throw new Error(`release-notes: ${file ?? '(no file given)'} is not ready: ${problems.join('; ')}`);
    stdout.write(`release-notes: ${file} is ready\n`);
    return;
  }

  if (flag('changelog')) {
    const dir = resolve(cwd, opt('dir') ?? 'release-notes');
    const entries = readNotesDir(dir, git);
    if (!entries.length) throw new Error(`release-notes: no vX.Y.Z.md files in ${dir}`);
    emit(renderChangelog(entries, repoUrl), opt('out'));
    return;
  }

  const to = parseVersion(opt('version'));
  if (!to) throw new Error('usage: release-notes.mjs --version X.Y.Z [--from <tag>] [--to <ref>] [--out file] | --changelog | --check FILE');
  const toRef = opt('to') ?? 'HEAD';
  const fromTag = opt('from') ?? previousTag(git, to);
  if (!fromTag) throw new Error(`release-notes: no stable tag older than ${formatVersion(to)}; pass --from`);
  const from = parseVersion(fromTag);
  if (!from) throw new Error(`release-notes: --from ${fromTag} is not a version tag (vX.Y.Z)`);

  const commits = readCommits(git, fromTag, toRef);
  let kind;
  try {
    kind = checkBump(commits, from, to);
  } catch (err) {
    // Only for drafting notes of releases already tagged with the wrong bump.
    if (!flag('allow-under-bump') || bumpKind(from, to) === 'none') throw err;
    process.stderr.write(`${err.message}\n  (--allow-under-bump: drafting anyway)\n`);
    kind = bumpKind(from, to);
  }
  const tree = readTreeChanges(git, fromTag, toRef);
  emit(renderDraft({ commits, tree, from, to, fromTag, kind, repoUrl }), opt('out'));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
