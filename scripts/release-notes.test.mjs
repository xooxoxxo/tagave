// Tests for release-notes.mjs and release.sh. No framework beyond node:test:
//   node --test scripts/release-notes.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DRAFT_MARKER, bumpKind, checkBump, classify, diffKeys, envKeys, main, migrationRange, notesProblems,
  parseCommit, parseFooters, parseVersion, releaseLabel, renderChangelog, requiredBump,
} from './release-notes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const commit = (subject, body = '') => parseCommit({ sha: 'a'.repeat(40), short: 'aaaaaaa', subject, body });
const v = (s) => parseVersion(s);

describe('parseCommit', () => {
  test('reads type, scope, subject', () => {
    const c = commit('feat(web): play a whole album');
    assert.equal(c.type, 'feat');
    assert.equal(c.scope, 'web');
    assert.equal(c.subject, 'play a whole album');
    assert.equal(c.breaking, false);
  });

  test('! marks a breaking change', () => {
    assert.equal(commit('refactor(api)!: drop the v1 routes').breaking, true);
    assert.equal(commit('feat!: rename everything').breaking, true);
  });

  test('a BREAKING CHANGE footer marks a breaking change and keeps its text', () => {
    const c = commit('feat(deploy): new compose layout', 'Longer body.\n\nBREAKING CHANGE: move .env next to compose.yml\nbefore updating.\nCo-Authored-By: X <x@example.com>');
    assert.equal(c.breaking, true);
    assert.deepEqual(c.breakingNotes, ['move .env next to compose.yml before updating.']);
  });

  test('BREAKING-CHANGE with a hyphen counts too', () => {
    assert.equal(commit('fix: x', 'BREAKING-CHANGE: y').breaking, true);
  });

  test('Requires-Attention footer is collected, any case', () => {
    assert.deepEqual(commit('fix(updater): x', 'requires-attention: Stop worker-files first.').attention, ['Stop worker-files first.']);
  });

  test('a non-conventional subject has no type', () => {
    const c = commit('Merge branch main');
    assert.equal(c.type, null);
    assert.equal(classify(c), 'unsorted');
  });
});

describe('parseFooters', () => {
  test('prose with a colon is not a footer', () => {
    assert.deepEqual(parseFooters('Note: this is prose.\n\nRefs: #12'), [{ key: 'Refs', value: '#12' }]);
  });
});

describe('classify', () => {
  const cases = [
    ['feat(web): x', 'new'],
    ['feat(installer): x', 'selfHosters'],
    ['feat(deploy): x', 'selfHosters'],
    ['fix(updater): x', 'fixed'],
    ['fix: x', 'fixed'],
    ['perf(web): x', 'improved'],
    ['perf(doctor): x', 'selfHosters'],
    ['refactor(web): x', 'improved'],
    ['refactor(core): x', null],
    ['docs(operations): x', 'selfHosters'],
    ['docs(install): x', 'selfHosters'],
    ['docs: x', null],
    ['docs(release): x', null],
    ['chore(deps): x', null],
    ['chore(installer): x', null],
    ['ci: x', null],
    ['test(web): x', null],
    ['build: x', null],
    ['ops: log caps', 'selfHosters'],
    ['wip: x', 'unsorted'],
  ];
  for (const [subject, want] of cases) test(`${subject} → ${want}`, () => assert.equal(classify(commit(subject)), want));
});

describe('versions', () => {
  test('parseVersion', () => {
    assert.deepEqual(v('v0.8.0'), { major: 0, minor: 8, patch: 0, pre: null });
    assert.deepEqual(v('1.2.3-rc.1'), { major: 1, minor: 2, patch: 3, pre: 'rc.1' });
    assert.equal(v('0.8'), null);
    assert.equal(v('latest'), null);
  });

  test('bumpKind', () => {
    assert.equal(bumpKind(v('0.7.7'), v('0.8.0')), 'minor');
    assert.equal(bumpKind(v('0.7.6'), v('0.7.7')), 'patch');
    assert.equal(bumpKind(v('0.9.0'), v('1.0.0')), 'major');
    assert.equal(bumpKind(v('0.9.0'), v('0.9.0')), 'none');
    assert.equal(bumpKind(v('0.9.0'), v('0.8.5')), 'none');
    assert.equal(bumpKind(v('0.9.0'), v('0.10.0-rc.1')), 'minor');
  });

  test('pre-1.0: breaking and feat need minor, the rest patch', () => {
    assert.equal(requiredBump([commit('fix: x')], v('0.7.0')), 'patch');
    assert.equal(requiredBump([commit('feat: x')], v('0.7.0')), 'minor');
    assert.equal(requiredBump([commit('fix!: x')], v('0.7.0')), 'minor');
  });

  test('from 1.0: breaking needs major', () => {
    assert.equal(requiredBump([commit('fix!: x')], v('1.4.0')), 'major');
    assert.equal(requiredBump([commit('feat: x')], v('1.4.0')), 'minor');
  });

  test('checkBump accepts enough and more', () => {
    assert.equal(checkBump([commit('fix: x')], v('0.7.6'), v('0.7.7')), 'patch');
    assert.equal(checkBump([commit('fix: x')], v('0.7.6'), v('0.8.0')), 'minor');
    assert.equal(checkBump([commit('feat!: x')], v('0.8.0'), v('0.9.0')), 'minor');
  });

  test('checkBump refuses an under-bump with the version to use', () => {
    assert.throws(() => checkBump([commit('feat(web): play')], v('0.7.7'), v('0.7.8')), /patch bump.*new features.*minor bump[\s\S]*--version 0\.8\.0/);
    assert.throws(() => checkBump([commit('fix(api)!: drop')], v('0.7.7'), v('0.7.8')), /breaking change/);
    assert.throws(() => checkBump([commit('fix!: drop')], v('1.2.0'), v('1.3.0')), /major bump[\s\S]*--version 2\.0\.0/);
  });

  test('checkBump refuses a version that is not newer', () => {
    assert.throws(() => checkBump([commit('fix: x')], v('0.9.0'), v('0.9.0')), /not newer/);
  });

  test('releaseLabel', () => {
    assert.equal(releaseLabel('minor', v('0.8.0'), v('0.9.0')), 'Minor release (0.8 → 0.9)');
    assert.equal(releaseLabel('patch', v('0.7.6'), v('0.7.7')), 'Patch release (0.7.6 → 0.7.7)');
    assert.equal(releaseLabel('major', v('0.9.0'), v('1.0.0')), 'Major release (0.9 → 1.0)');
  });
});

describe('env keys and migrations', () => {
  test('envKeys reads KEY= lines (commented too) and ${KEY references', () => {
    const keys = envKeys('APP_SECRET=\n# TAGAVE_PORT=3100\n  x: ${TAGAVE_DIGEST_APP:+@${TAGAVE_DIGEST_APP}}\n');
    assert.deepEqual([...keys].sort(), ['APP_SECRET', 'TAGAVE_DIGEST_APP', 'TAGAVE_PORT']);
  });

  test('diffKeys finds added, removed and renamed keys', () => {
    const d = diffKeys(new Set(['APP_SECRET', 'LINER_PORT', 'OLD_THING']), new Set(['APP_SECRET', 'TAGAVE_PORT', 'NEW_KEY']));
    assert.deepEqual(d.renamed, [['LINER_PORT', 'TAGAVE_PORT']]);
    assert.deepEqual(d.added, ['NEW_KEY']);
    assert.deepEqual(d.removed, ['OLD_THING']);
  });

  test('migrationRange', () => {
    assert.equal(migrationRange(['m/0042_a.sql', 'm/0043_b.sql', 'm/0045_c.sql', 'm/0044_d.sql']), 'migrations 0042–0045');
    assert.equal(migrationRange(['m/0041_player.sql']), 'migration 0041');
    assert.equal(migrationRange(['m/0010_a.sql', 'm/0012_b.sql']), 'migrations 0010, 0012');
    // an app's or module's own chain is numbered on its own and named
    assert.equal(
      migrationRange(['m/0065_a.sql', 'm/modules/decider/0002_b.sql', 'm/0066_b.sql', 'm/modules/decider/0001_a.sql', 'm/apps/books/0001_x.sql']),
      'migrations 0065–0066 and books migration 0001 and decider migrations 0001–0002',
    );
    assert.equal(migrationRange(['m/modules/decider/0001_a.sql']), 'decider migration 0001');
  });
});

describe('notesProblems', () => {
  test('a finished file passes', () => assert.deepEqual(notesProblems('**Minor release (0.8 → 0.9).** Done.\n'), []));
  test('missing, draft marker, TODO fail', () => {
    assert.equal(notesProblems(null).length, 1);
    assert.match(notesProblems(`${DRAFT_MARKER}\nx`).join(), /draft marker/);
    assert.match(notesProblems('**Patch.** TODO: summary').join(), /TODO/);
  });
});

describe('renderChangelog', () => {
  test('newest first, headings demoted, draft marker and TODO summary stripped', () => {
    const text = renderChangelog([
      { version: '0.7.10', text: `${DRAFT_MARKER}\n**Patch release (0.7.9 → 0.7.10).** TODO: summary\n\n## Fixed\n\n- x\n`, date: null },
      { version: '0.9.0', text: '**Minor release (0.8 → 0.9).** Done.\n\n## New\n\n- y\n', date: '2026-10-16' },
      { version: '0.7.9', text: '**Patch.**\n', date: null },
    ]);
    const order = ['v0.9.0', 'v0.7.10', 'v0.7.9'].map((t) => text.indexOf(`## [${t}]`));
    assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), 'versions in descending order');
    assert.match(text, /## \[v0\.9\.0\]\(.*\) \(2026-10-16\)/);
    assert.match(text, /^### New$/m);
    assert.ok(!text.includes(DRAFT_MARKER));
    assert.ok(!text.includes('TODO:'));
    assert.match(text, /Generated from the commits/);
  });
});

// -- against a real repository ------------------------------------------------------

const tmpRoots = [];
after(() => tmpRoots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-test-'));
  tmpRoots.push(dir);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commitAll = (message) => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
  };
  write('package.json', '{\n  "name": "x",\n  "version": "0.4.0"\n}\n');
  write('.env.example', 'APP_SECRET=\n# LINER_PORT=3100\n');
  write('deploy/compose.yml', 'x: ${APP_SECRET}\n');
  write('packages/db/migrations/0001_init.sql', 'select 1;\n');
  write('.gitignore', 'node_modules\n');
  commitAll('chore: 0.4.0');
  git('tag', '-a', 'v0.4.0', '-m', 'v0.4.0');
  return { dir, git, write, commitAll };
}

function run(dir, args) {
  let text = '';
  main(args, { cwd: dir, stdout: { write: (s) => { text += s; } } });
  return text;
}

describe('draft from a repository', () => {
  const { dir, git, write, commitAll } = makeRepo();
  write('packages/db/migrations/0002_users.sql', 'select 2;\n');
  write('packages/db/migrations/modules/decider/0001_runs.sql', 'select 3;\n');
  commitAll('feat(api): people and roles');
  write('.env.example', 'APP_SECRET=\n# TAGAVE_PORT=3100\n# TAGAVE_NEW=1\n');
  commitAll('refactor!: rename liner to tagave\n\nBREAKING CHANGE: LINER_* settings are now TAGAVE_*.');
  commitAll('fix(updater): keep file owners\n\nRequires-Attention: Stop worker-files on the music computer first.');
  commitAll('chore(deps): bump things');
  commitAll('docs(operations): going back');
  commitAll('random words');
  git('checkout', '-q', '-b', 'side');
  commitAll('feat(web): side work');
  git('checkout', '-q', 'main');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'merge', '-q', '--no-ff', '-m', 'Merge branch side', 'side');

  test('every section and detector', () => {
    const text = run(dir, ['--version', '0.5.0']);
    assert.ok(text.startsWith(`${DRAFT_MARKER}\n**Minor release (0.4 → 0.5).** TODO: summary`));
    assert.match(text, /^\*\*Requires attention:\*\* Stop worker-files on the music computer first\. LINER_\* settings are now TAGAVE_\*\./m);
    assert.match(text, /\*\*Breaking: Rename liner to tagave\.\*\* LINER_\* settings are now TAGAVE_\*\./);
    assert.match(text, /Going back to 0\.4 means a restore.*migration 0002 and decider migration 0001/);
    assert.match(text, /\.env\.example`:\*\* added `TAGAVE_NEW`; renamed `LINER_PORT` → `TAGAVE_PORT`/);
    assert.match(text, /## New\n\n- \*\*api:\*\* People and roles \(\[[0-9a-f]{7}\]\(https:\/\/github\.com\/xooxoxxo\/tagave\/commit\/[0-9a-f]{7}\)\)\n- \*\*web:\*\* Side work/);
    assert.match(text, /## Fixed\n\n- \*\*updater:\*\* Keep file owners/);
    assert.match(text, /## For self-hosters\n\n- \*\*Migrations:\*\* 0002 users, decider 0001 runs\.\n- \*\*operations:\*\* Going back/);
    assert.match(text, /## Unsorted[\s\S]*- random words/);
    assert.ok(!text.includes('bump things'));
    assert.ok(!text.includes('Merge branch'));
    assert.match(text, /\*\*All changes:\*\* \[v0\.4\.0\.\.\.v0\.5\.0\]\(https:\/\/github\.com\/xooxoxxo\/tagave\/compare\/v0\.4\.0\.\.\.v0\.5\.0\)/);
    // The app flags a release for attention on this pattern (updatesFeed.ts).
    assert.match(text, /requires[- ]attention/i);
  });

  test('refuses an under-bump', () => {
    assert.throws(() => run(dir, ['--version', '0.4.1']), /patch bump.*breaking change/);
  });

  test('--allow-under-bump drafts anyway, labelled by the actual bump', () => {
    const text = run(dir, ['--version', '0.4.1', '--allow-under-bump']);
    assert.match(text, /\*\*Patch release \(0\.4\.0 → 0\.4\.1\)\.\*\*/);
    assert.throws(() => run(dir, ['--from', 'v0.4.0', '--version', '0.4.0', '--allow-under-bump']), /not newer/);
  });

  test('--from defaults to the previous stable tag', () => {
    assert.match(run(dir, ['--version', '0.5.0']), /v0\.4\.0\.\.\.v0\.5\.0/);
  });
});

describe('release.sh', () => {
  const { dir, git, commitAll } = makeRepo();
  mkdirSync(join(dir, 'scripts'));
  for (const f of ['release.sh', 'release-notes.mjs']) copyFileSync(join(HERE, f), join(dir, 'scripts', f));
  commitAll('chore: release scripts');
  commitAll('fix(web): a fix');
  const release = (...args) => spawnSync('bash', ['scripts/release.sh', ...args], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null' },
  });

  test('refuses a bad version argument', () => assert.equal(release('next').status, 2));

  test('refuses a non-main branch', () => {
    git('checkout', '-q', '-b', 'topic');
    const r = release('0.4.1');
    git('checkout', '-q', 'main');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /releases are cut from main/);
  });

  test('refuses a dirty tree', () => {
    writeFileSync(join(dir, '.env.example'), 'CHANGED=\n');
    const r = release('0.4.1');
    git('checkout', '-q', '--', '.env.example');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /uncommitted changes/);
  });

  test('first run writes the draft and stops; draft refused; edited notes commit and tag', () => {
    let r = release('0.4.1');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wrote the draft release-notes\/v0\.4\.1\.md/);
    const notes = join(dir, 'release-notes/v0.4.1.md');
    assert.ok(readFileSync(notes, 'utf8').startsWith(DRAFT_MARKER));
    assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /"version": "0\.4\.1"/);

    r = release('0.4.1');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /draft marker/);

    writeFileSync(notes, '**Patch release (0.4.0 → 0.4.1).** One fix.\n\n## Fixed\n\n- A fix.\n');
    r = release('0.4.1');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /git push origin v0\.4\.1/);
    assert.equal(git('log', '-1', '--format=%s').trim(), 'chore: 0.4.1');
    assert.equal(git('cat-file', '-t', 'v0.4.1').trim(), 'tag');
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['CHANGELOG.md', 'package.json', 'release-notes/v0.4.1.md']);
    assert.match(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), /## \[v0\.4\.1\]/);
    assert.equal(git('status', '--porcelain', '--untracked-files=no').trim(), '');
  });

  test('refuses an existing tag', () => {
    const r = release('0.4.1');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists/);
  });

  test('refuses an under-bump before touching package.json', () => {
    commitAll('feat(web): a feature');
    const r = release('0.4.2');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /minor bump/);
    assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /"version": "0\.4\.1"/);
  });
});
