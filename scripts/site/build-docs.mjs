#!/usr/bin/env node
// Builds tagave.app/docs from docs/*.md and CHANGELOG.md, so the site and
// GitHub never disagree. Output goes to site/docs/ (build output, gitignored).
//
//   node scripts/site/build-docs.mjs
//
// Links between guides become /docs/<slug>/#anchor, links to other repo files
// go to GitHub, and a relative link to a file that does not exist fails the
// build.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { page, overview, escapeHtml } from './template.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const SITE = 'https://tagave.app';
export const GITHUB = 'https://github.com/xooxoxxo/tagave';

// The guides, in sidebar order. `file` is relative to the repository root.
export const GUIDES = [
  { slug: 'install', file: 'docs/install.md', title: 'Install', group: 'Start', blurb: 'Run the installer, or set it up by hand.' },
  { slug: 'features', file: 'docs/features.md', title: 'Features', group: 'Start', blurb: 'What tagave does, one area at a time.' },
  { slug: 'tag-correction', file: 'docs/tag-correction.md', title: 'Tag correction', group: 'Use', blurb: 'How plans preview, write and revert tags.' },
  { slug: 'operations', file: 'docs/operations.md', title: 'Operations', group: 'Use', blurb: 'Health checks, updates, backups and restores.' },
  { slug: 'security', file: 'docs/security.md', title: 'Security', group: 'Use', blurb: 'Secrets, sessions, backups and HTTPS.' },
  { slug: 'architecture', file: 'docs/architecture.md', title: 'Architecture', group: 'Project', blurb: 'The packages, the job flow and a dev setup.' },
  { slug: 'design-system', file: 'docs/design/system.md', title: 'Design system', group: 'Project', blurb: 'The tokens and components behind the interface.' },
  { slug: 'changelog', file: 'CHANGELOG.md', title: 'Changelog', group: 'Project', blurb: 'Every release, newest first.' },
];
export const GROUPS = ['Start', 'Use', 'Project'];

const BY_FILE = new Map(GUIDES.map((g) => [g.file, g]));

// ---------------------------------------------------------------- slugs

// GitHub's heading ids (github-slugger): lowercase, drop everything but
// letters, marks, numbers, connector punctuation, spaces and hyphens, then
// spaces to hyphens. Repeats get -1, -2, ...
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

export function createSlugger() {
  const seen = new Map();
  return function slug(text) {
    const base = slugify(text);
    let result = base;
    while (seen.has(result)) {
      const n = seen.get(base) + 1;
      seen.set(base, n);
      result = `${base}-${n}`;
    }
    seen.set(result, 0);
    return result;
  };
}

// v0.11.0 -> v0-11-0: stable, and free of the date GitHub would fold in.
export function versionAnchor(version) {
  return version.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

// ---------------------------------------------------------------- links

export class LinkError extends Error {}

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Rewrites one href found in `fromFile` (repo-relative). Returns
 * { href, image? } where image is the repo path of a docs/images file to copy.
 * `exists(path)` and `isDir(path)` take repo-relative paths.
 */
export function rewriteHref(href, fromFile, { exists, isDir } = fsProbe()) {
  if (!href || href.startsWith('#') || ABSOLUTE.test(href) || href.startsWith('/')) return { href };
  const cut = href.search(/[?#]/);
  const rawPath = cut === -1 ? href : href.slice(0, cut);
  const suffix = cut === -1 ? '' : href.slice(cut);
  const hash = suffix.includes('#') ? suffix.slice(suffix.indexOf('#')) : '';
  let path;
  try {
    path = decodeURI(rawPath);
  } catch {
    path = rawPath;
  }
  const target = posix.normalize(posix.join(posix.dirname(fromFile), path)).replace(/\/$/, '');
  if (target === '..' || target.startsWith('../')) {
    throw new LinkError(`${fromFile}: link "${href}" points outside the repository`);
  }
  if (target === '' || target === '.') return { href: `${GITHUB}${hash}` };
  const guide = BY_FILE.get(target);
  if (guide) return { href: `/docs/${guide.slug}/${hash}` };
  if (!exists(target)) {
    throw new LinkError(`${fromFile}: link "${href}" points to ${target}, which does not exist`);
  }
  if (target.startsWith('docs/images/') && !isDir(target)) {
    return { href: `/docs/images/${target.slice('docs/images/'.length)}`, image: target };
  }
  const kind = isDir(target) ? 'tree' : 'blob';
  return { href: `${GITHUB}/${kind}/main/${target.split('/').map(encodeURIComponent).join('/')}${suffix}` };
}

function fsProbe(root = REPO_ROOT) {
  return {
    exists: (p) => existsSync(join(root, p)),
    isDir: (p) => existsSync(join(root, p)) && statSync(join(root, p)).isDirectory(),
  };
}

// ---------------------------------------------------------------- markdown

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Renders one markdown file. Returns { title, html, toc, description, images }.
 * The first h1 becomes the page title and is not part of `html`.
 * `opts.changelog` renders each `## [vX.Y.Z](url) (date)` as a release heading.
 */
export function renderMarkdown(source, fromFile, opts = {}) {
  const probe = opts.probe ?? fsProbe();
  const slug = createSlugger();
  const toc = [];
  const images = new Set();
  let title = null;
  const link = (href) => {
    const r = rewriteHref(href, fromFile, probe);
    if (r.image) images.add(r.image);
    return r.href;
  };

  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(token) {
      if (token.type === 'link' || token.type === 'image') token.href = link(token.href);
    },
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const plain = decodeEntities(this.parser.parseInline(tokens, this.parser.textRenderer));
        if (depth === 1 && title === null) {
          title = plain.trim();
          return '';
        }
        if (opts.changelog && depth === 2) {
          const m = plain.match(/^(v\d+\.\d+\.\d+\S*)\s*(?:\((\d{4}-\d{2}-\d{2})\))?/);
          if (m) {
            const id = versionAnchor(m[1]);
            slug(id); // reserve it so a later heading cannot take it
            const release = tokens.find((t) => t.type === 'link');
            toc.push({ id, text: m[1] });
            const when = m[2] ? `<time datetime="${m[2]}">${formatDate(m[2])}</time>` : '';
            const gh = release ? `<a class="release-link" href="${escapeHtml(release.href)}">Release notes on GitHub</a>` : '';
            return `<h2 id="${id}" class="release"><span class="release-v">${escapeHtml(m[1])}</span>${when}<a class="hash" href="#${id}" aria-label="Link to ${escapeHtml(m[1])}">#</a></h2>${gh ? `<p class="release-meta">${gh}</p>` : ''}\n`;
          }
        }
        const id = slug(plain);
        if (depth === 2) toc.push({ id, text: plain.trim() });
        return `<h${depth} id="${id}">${inner}<a class="hash" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      table(token) {
        // marked's own table markup, in a wrapper that scrolls on its own
        return `<div class="table-wrap" tabindex="0" role="region" aria-label="Table">${marked.Renderer.prototype.table.call(this, token)}</div>\n`;
      },
    },
  });

  const html = marked.parse(source);
  const description = firstParagraph(source);
  return { title: title ?? fromFile, html, toc, description, images: [...images] };
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

// The first prose paragraph as plain text, for <meta name="description">.
export function firstParagraph(source, max = 160) {
  const blocks = source.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  const para = blocks.find((b) => {
    const t = b.trim();
    return t && !/^(#|```|\||>|[-*+] |\d+\. |<)/.test(t);
  });
  if (!para) return '';
  let text = para
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > max) {
    text = text.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  }
  return text;
}

export function latestVersion(changelog) {
  const m = changelog.match(/^##\s+\[?(v\d+\.\d+\.\d+[^\]\s]*)/m);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- build

export function build({ root = REPO_ROOT, out = join(root, 'site', 'docs'), log = console.log } = {}) {
  const probe = fsProbe(root);
  const changelogSource = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const version = latestVersion(changelogSource);
  const errors = [];
  const pages = [];
  const images = new Set();

  for (const guide of GUIDES) {
    const source = readFileSync(join(root, guide.file), 'utf8');
    try {
      const doc = renderMarkdown(source, guide.file, { probe, changelog: guide.slug === 'changelog' });
      doc.images.forEach((i) => images.add(i));
      pages.push({ guide, doc });
    } catch (err) {
      if (err instanceof LinkError) errors.push(err.message);
      else throw err;
    }
  }
  if (errors.length) {
    throw new LinkError(`Broken links:\n  ${errors.join('\n  ')}`);
  }
  if (pages.length !== GUIDES.length) throw new Error('docs build: some guides did not render');

  const anchors = missingAnchors(pages);
  for (const a of anchors) log(`docs: warning: ${a}`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const ctx = { guides: GUIDES, groups: GROUPS, version };

  writeFileSync(join(out, 'index.html'), overview(ctx));
  for (const { guide, doc } of pages) {
    const dir = join(out, guide.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), page(ctx, guide, doc));
  }
  copyFileSync(join(HERE, 'docs.css'), join(out, 'docs.css'));
  copyFileSync(join(HERE, 'docs.js'), join(out, 'docs.js'));
  for (const img of images) {
    const dest = join(out, 'images', img.slice('docs/images/'.length));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(root, img), dest);
  }

  const urls = ['/', '/docs/', ...GUIDES.map((g) => `/docs/${g.slug}/`)];
  writeFileSync(
    join(root, 'site', 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${SITE}${u}</loc></url>`)
      .join('\n')}\n</urlset>\n`,
  );
  log(`docs: ${pages.length} guides, ${images.size} images, ${version ?? 'no version'} -> ${out}`);
  return { pages, version, images: [...images], anchors };
}

// Links to a #section that no heading on the target page has. Reported, not
// fatal: GitHub would land on the top of the page too.
export function missingAnchors(pages) {
  const ids = new Map(pages.map(({ guide, doc }) => [guide.slug, new Set([...doc.html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
  const out = [];
  for (const { guide, doc } of pages) {
    for (const m of doc.html.matchAll(/href="(?:\/docs\/([a-z0-9-]+)\/)?#([^"]+)"/g)) {
      const slug = m[1] ?? guide.slug;
      if (!ids.get(slug)?.has(m[2])) out.push(`${guide.file}: link to /docs/${slug}/#${m[2]}, no such heading`);
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    build();
  } catch (err) {
    console.error(`docs build failed: ${err.message}`);
    process.exit(1);
  }
}
