// node --test scripts/site/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  slugify,
  createSlugger,
  rewriteHref,
  renderMarkdown,
  LinkError,
  dropIntro,
  latestVersion,
  build,
  REPO_ROOT,
  GITHUB,
} from './build-docs.mjs';

const files = new Set(['docs/install.md', 'docs/security.md', 'LICENSE', 'CHANGELOG.md', 'deploy/templates/compose.yml', 'docs/images/shot.png']);
const dirs = new Set(['deploy/templates', 'release-notes']);
const probe = { exists: (p) => files.has(p) || dirs.has(p), isDir: (p) => dirs.has(p) };

test('heading ids follow GitHub', () => {
  assert.equal(slugify('Music on another computer'), 'music-on-another-computer');
  assert.equal(slugify('Play your music (optional player)'), 'play-your-music-optional-player');
  assert.equal(slugify('`APP_SECRET`'), 'app_secret');
  assert.equal(slugify('Create .env'), 'create-env');
  assert.equal(slugify('Roll back & restore'), 'roll-back--restore');
});

test('repeated headings get -1, -2', () => {
  const slug = createSlugger();
  assert.equal(slug('Before you update'), 'before-you-update');
  assert.equal(slug('Before you update'), 'before-you-update-1');
  assert.equal(slug('Before you update'), 'before-you-update-2');
  assert.equal(slug('before-you-update-1'), 'before-you-update-1-1');
});

test('links between guides keep their anchor', () => {
  assert.equal(rewriteHref('install.md#music-on-another-computer', 'docs/security.md', probe).href, '/docs/install/#music-on-another-computer');
  assert.equal(rewriteHref('docs/install.md', 'README.md', probe).href, '/docs/install/');
  assert.equal(rewriteHref('../docs/security.md#app_secret', 'docs/install.md', probe).href, '/docs/security/#app_secret');
  assert.equal(rewriteHref('../security.md', 'docs/design/system.md', probe).href, '/docs/security/');
});

test('CHANGELOG.md goes to the changelog page', () => {
  assert.equal(rewriteHref('../CHANGELOG.md', 'docs/install.md', probe).href, '/docs/changelog/');
  assert.equal(rewriteHref('../CHANGELOG.md#v0-11-0', 'docs/install.md', probe).href, '/docs/changelog/#v0-11-0');
});

test('other repo files go to GitHub', () => {
  assert.equal(rewriteHref('../LICENSE', 'docs/install.md', probe).href, `${GITHUB}/blob/main/LICENSE`);
  assert.equal(rewriteHref('../deploy/templates/compose.yml', 'docs/install.md', probe).href, `${GITHUB}/blob/main/deploy/templates/compose.yml`);
  assert.equal(rewriteHref('../deploy/templates/', 'docs/install.md', probe).href, `${GITHUB}/tree/main/deploy/templates`);
  assert.equal(rewriteHref('release-notes/', 'CHANGELOG.md', probe).href, `${GITHUB}/tree/main/release-notes`);
});

test('images in docs/images are served from /docs/images', () => {
  assert.deepEqual(rewriteHref('images/shot.png', 'docs/install.md', probe), { href: '/docs/images/shot.png', image: 'docs/images/shot.png' });
});

test('external links and in-page anchors are unchanged', () => {
  for (const href of ['https://musicbrainz.org', 'http://localhost:3100', 'mailto:a@b.c', '#updates', '/img/og.png']) {
    assert.equal(rewriteHref(href, 'docs/install.md', probe).href, href);
  }
});

test('a link to a missing file fails', () => {
  assert.throws(() => rewriteHref('nope.md', 'docs/install.md', probe), LinkError);
  assert.throws(() => rewriteHref('../../outside.md', 'docs/install.md', probe), LinkError);
  assert.throws(() => renderMarkdown('# T\n\nSee [x](missing.md).\n', 'docs/install.md', { probe }), /missing\.md/);
});

const CHANGELOG = `# Changelog

Every release, newest first.

## [v0.11.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.11.0)

### Before you update

- one

## [v0.10.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.10.0) (2026-10-20)

### Before you update

- two

## [v0.9.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.9.0) (2026-10-16)
`;

test('the changelog has one anchor per version, newest first', () => {
  const doc = renderMarkdown(CHANGELOG, 'CHANGELOG.md', { probe, changelog: true });
  assert.deepEqual(doc.toc.map((t) => t.id), ['v0-11-0', 'v0-10-0', 'v0-9-0']);
  for (const id of ['v0-11-0', 'v0-10-0', 'v0-9-0']) {
    assert.equal(doc.html.split(`id="${id}"`).length - 1, 1, id);
  }
  assert.match(doc.html, /id="before-you-update"/);
  assert.match(doc.html, /id="before-you-update-1"/);
  assert.match(doc.html, /<time datetime="2026-10-20">20 Oct 2026<\/time>/);
  assert.equal(latestVersion(CHANGELOG), 'v0.11.0');
});

test('the changelog page drops the maintainer intro', () => {
  const src = '# Changelog\n\nAssembled from [`release-notes/`](release-notes/) by a script; edit the notes there.\n\n## [v1.0.0](https://x)\n\nBody.\n';
  assert.doesNotMatch(dropIntro(src), /Assembled/);
  assert.match(dropIntro(src), /^# Changelog\n/);
  const doc = renderMarkdown(src, 'CHANGELOG.md', { probe, changelog: true });
  assert.doesNotMatch(doc.html, /Assembled|release-notes/);
  assert.match(doc.html, /Body\./);
});

test('tables get their own scrolling wrapper', () => {
  const doc = renderMarkdown('# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n', 'docs/install.md', { probe });
  assert.match(doc.html, /<div class="table-wrap"[^>]*><table>/);
});

test('the real docs build, one page per guide and a version per changelog entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagave-docs-'));
  try {
    for (const p of ['docs', 'CHANGELOG.md', 'LICENSE', 'deploy', 'release-notes', 'scripts/site', 'README.md']) {
      if (existsSync(join(REPO_ROOT, p))) cpSync(join(REPO_ROOT, p), join(root, p), { recursive: true });
    }
    mkdirSync(join(root, 'site'), { recursive: true });
    const result = build({ root, log: () => {} });
    for (const slug of ['install', 'features', 'tag-correction', 'operations', 'security', 'architecture', 'design-system', 'changelog']) {
      assert.ok(existsSync(join(root, 'site/docs', slug, 'index.html')), slug);
    }
    const changelog = readFileSync(join(root, 'site/docs/changelog/index.html'), 'utf8');
    const versions = [...readFileSync(join(root, 'CHANGELOG.md'), 'utf8').matchAll(/^## \[(v[^\]]+)\]/gm)].map((m) => m[1]);
    assert.ok(versions.length > 0);
    for (const v of versions) {
      const id = v.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      assert.equal(changelog.split(`id="${id}"`).length - 1, 1, id);
    }
    assert.equal(result.version, versions[0]);
    assert.doesNotMatch(changelog, /Assembled from|edit the notes there/);
    assert.match(changelog, /<p class="lede">Every release, newest first\.<\/p>/);
    assert.match(readFileSync(join(root, 'site/sitemap.xml'), 'utf8'), /https:\/\/tagave\.app\/docs\/changelog\//);

    // and a broken link stops it
    writeFileSync(join(root, 'docs/features.md'), '# Features\n\nSee [gone](gone.md).\n');
    assert.throws(() => build({ root, log: () => {} }), /gone\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
